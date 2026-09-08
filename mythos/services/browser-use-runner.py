"""browser-use-runner.py — one browser task, in, one JSON line, out.

stdin (JSON):  {task, url?, cdp_url, provider, model, max_steps, timeout_s}
stdout:        exactly one JSON line:
               {ok, done, successful, steps, seconds, result, final_url, final_title, urls, errors, model}
exit codes:    0 done · 2 stopped before done (max steps / gave up) · 3 model or provider
               error (quota, auth, retired model) · 4 browser unreachable · 5 bad input

Keys arrive ONLY through this process's environment (GOOGLE_API_KEY, GROQ_API_KEY,
MISTRAL_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL) and are passed to the chat class
explicitly, so browser-use's own .env auto-loading can never outrank what MYTHOS handed
over. Groq and OpenAI-compatible endpoints are driven text-only (their free tiers reject
image parts with "content must be a string"); Gemini and Mistral get screenshots.

Measured 2026-09-08 (browser-use 0.13.10): gemini-3.6-flash played the second YouTube
result 3/3 in 5-7 steps, 87-108 s. Free tiers: Gemini 20 req/day/model, Groq 8k tokens per
request (a step needs ~9k). The customer's key, the customer's bill.
"""
import asyncio
import json
import os
import sys
import time
import urllib.request

PROVIDER_ERROR_MARKS = ('429', 'RESOURCE_EXHAUSTED', 'quota', 'Rate limit', '401', '403', '402', '404 NOT_FOUND', 'no longer available', '413', 'Request too large')


def emit(payload, code):
    sys.stdout.write(json.dumps(payload) + '\n')
    sys.stdout.flush()
    sys.exit(code)


def cdp_alive(cdp_url):
    try:
        with urllib.request.urlopen(cdp_url.rstrip('/') + '/json/version', timeout=4) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def make_llm(provider, model):
    if provider == 'google':
        from browser_use import ChatGoogle
        return ChatGoogle(model=model, api_key=os.environ['GOOGLE_API_KEY']), True
    if provider == 'groq':
        from browser_use import ChatGroq
        return ChatGroq(model=model, api_key=os.environ['GROQ_API_KEY']), False
    if provider == 'mistral':
        from browser_use import ChatMistral
        return ChatMistral(model=model, api_key=os.environ['MISTRAL_API_KEY']), True
    if provider in ('openai', 'openai-compatible'):
        from browser_use import ChatOpenAI
        base = os.environ.get('OPENAI_BASE_URL')
        return ChatOpenAI(model=model, api_key=os.environ['OPENAI_API_KEY'], base_url=base) if base else ChatOpenAI(model=model, api_key=os.environ['OPENAI_API_KEY']), provider == 'openai'
    raise ValueError('unknown provider ' + repr(provider))


async def main():
    try:
        req = json.loads(sys.stdin.read())
        task = str(req['task'])
        cdp_url = str(req['cdp_url'])
        provider = str(req['provider'])
        model = str(req['model'])
    except Exception as e:  # noqa: BLE001
        emit({'ok': False, 'error': 'bad input: ' + str(e)[:200]}, 5)
    out = {'ok': False, 'model': provider + '/' + model, 'steps': 0, 'urls': [], 'errors': []}
    if not cdp_alive(cdp_url):
        out['error'] = 'no debuggable browser at ' + cdp_url
        emit(out, 4)
    try:
        llm, vision = make_llm(provider, model)
    except KeyError as e:
        out['error'] = 'missing key in environment: ' + str(e)
        emit(out, 3)
    except Exception as e:  # noqa: BLE001
        out['error'] = 'model setup failed: ' + str(e)[:300]
        emit(out, 3)
    from browser_use import Agent, Browser
    browser = Browser(cdp_url=cdp_url, keep_alive=True)
    full_task = task if not req.get('url') else 'Start at ' + str(req['url']) + '. ' + task
    agent = Agent(task=full_task, llm=llm, browser=browser, use_vision=vision)
    t0 = time.time()
    try:
        h = await agent.run(max_steps=int(req.get('max_steps') or 25))
    except Exception as e:  # noqa: BLE001
        out.update(error='agent failed: ' + str(e)[:400], seconds=round(time.time() - t0, 1))
        emit(out, 3 if any(m in str(e) for m in PROVIDER_ERROR_MARKS) else 2)
    urls = [u for u in h.urls() if u]
    errors = [str(e)[:300] for e in h.errors() if e]
    out.update(done=bool(h.is_done()), successful=h.is_successful(), steps=h.number_of_steps(),
               seconds=round(time.time() - t0, 1), result=(h.final_result() or '')[:800],
               final_url=urls[-1] if urls else None, urls=urls[-6:], errors=errors[-3:])
    try:
        with urllib.request.urlopen(cdp_url.rstrip('/') + '/json', timeout=3) as r:
            pages = [p for p in json.load(r) if p.get('type') == 'page']
            page = next((p for p in pages if p.get('url') == out['final_url']), pages[-1] if pages else None)
            out['final_title'] = page.get('title') if page else None
    except Exception:  # noqa: BLE001
        out['final_title'] = None
    if out['done'] and out['successful'] is not False:
        out['ok'] = True
        emit(out, 0)
    provider_error = any(any(m in e for m in PROVIDER_ERROR_MARKS) for e in errors)
    out['error'] = (errors[-1] if errors else 'stopped before the task was done')
    emit(out, 3 if provider_error else 2)


asyncio.run(main())
