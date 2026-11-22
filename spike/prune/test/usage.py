import json, sys
seen = {}
for line in open(sys.argv[1]):
    try: e = json.loads(line)
    except Exception: continue
    t = e.get('type')
    if t == 'system' and e.get('subtype') == 'init':
        print('  session', e.get('session_id'), '| plugins has prune-spike:', any(p.get('name') == 'prune-spike' for p in e.get('plugins', [])))
    elif t == 'system' and e.get('subtype') not in ('hook_started', 'hook_response', 'thinking_tokens'):
        print('  system:', e.get('subtype'), json.dumps({k: v for k, v in e.items() if k not in ('type', 'subtype', 'uuid', 'session_id')})[:400])
    elif t == 'assistant':
        m = e['message']; u = m.get('usage', {})
        seen[m['id']] = (u.get('input_tokens', 0), u.get('cache_creation_input_tokens', 0), u.get('cache_read_input_tokens', 0))
    elif t == 'result':
        print('  result:', e.get('subtype'), 'is_error', e.get('is_error'), repr(str(e.get('result'))[:200]))
for i, (k, (a, b, c)) in enumerate(seen.items(), 1):
    print(f'  call {i}: context {a+b+c}  (uncached {a}, cache write {b}, cache read {c})')
