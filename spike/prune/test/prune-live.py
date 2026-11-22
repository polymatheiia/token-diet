"""One headless process, three turns: build tool results, /compact (answered by the spike hook), ask again."""
import json, subprocess, sys, os
S = os.path.dirname(os.path.abspath(__file__))
os.chdir(os.path.join(S, 'prune-test'))
if os.path.exists('prune-spike.log'): os.remove('prune-spike.log')
prompts = sys.argv[1:] or [
    'Run these three Bash commands one after another, each as its own separate tool call, waiting for each result: (1) python3 -c "print(chr(97)*6000)"  (2) python3 -c "print(chr(98)*6000)"  (3) python3 -c "print(chr(99)*6000)"  Then reply with the single word OK.',
    '/compact',
    'What do you now see as the output of the first Bash command in this conversation? Quote its first 40 characters exactly.',
    'Reply with the single word OK.',
]
p = subprocess.Popen(['claude', '-p', '--model', 'haiku', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
                      '--allowedTools', 'Bash', '--plugin-dir', '/home/sool/Projects/token-diet/spike/prune'],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(S, 'p-live.err'), 'w'), text=True)
log = open(os.path.join(S, 'p-live.jsonl'), 'w')
for n, prompt in enumerate(prompts, 1):
    p.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': prompt}}) + '\n'); p.stdin.flush()
    print(f'== turn {n}: {prompt[:60]!r}')
    seen = {}
    for line in p.stdout:
        log.write(line)
        try: e = json.loads(line)
        except Exception: continue
        t = e.get('type')
        if t == 'system' and e.get('subtype') == 'init': print('  session', e.get('session_id'))
        elif t == 'system' and e.get('subtype') == 'compact_boundary': print('  compact_boundary', json.dumps(e.get('compact_metadata'))[:200])
        elif t == 'system' and e.get('subtype') == 'status': print('  status', e.get('status'), e.get('compact_result'))
        elif t == 'assistant':
            u = e['message'].get('usage', {})
            seen[e['message']['id']] = (u.get('input_tokens', 0), u.get('cache_creation_input_tokens', 0), u.get('cache_read_input_tokens', 0))
        elif t == 'result':
            print('  result:', e.get('subtype'), repr(str(e.get('result'))[:160])); break
    for i, (a, b, c) in enumerate(seen.values(), 1):
        print(f'  call {i}: context {a+b+c}  (uncached {a}, cache write {b}, cache read {c})')
p.stdin.close()
try: p.wait(timeout=30)
except Exception: p.kill()
print('-- hook log:', open('prune-spike.log').read().strip() if os.path.exists('prune-spike.log') else '(none)')
