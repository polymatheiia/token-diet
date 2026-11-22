#!/bin/sh
S=$(dirname "$0"); P=/home/sool/Projects/token-diet/spike/prune; cd "$S/prune-test" || exit 1; rm -f prune-spike.log
run() { label=$1; shift; timeout 170 claude -p "$@" --model haiku --output-format stream-json --verbose --allowedTools Bash --plugin-dir "$P" < /dev/null > "$S/p-$label.jsonl" 2> "$S/p-$label.err"; echo "== $label exit=$?"; python3 "$S/usage.py" "$S/p-$label.jsonl"; head -c 400 "$S/p-$label.err"; }
run 1 'Run these three Bash commands one after another, each as its own separate tool call, waiting for each result: (1) python3 -c "print(chr(97)*6000)"  (2) python3 -c "print(chr(98)*6000)"  (3) python3 -c "print(chr(99)*6000)"  Then reply with the single word OK.'
id=$(python3 -c "
import json,sys
for l in open('$S/p-1.jsonl'):
    e=json.loads(l)
    if e.get('type')=='result': print(e['session_id'])")
echo "session id: $id"; echo "$id" > "$S/prune-id"
run 2 --resume "$id" '/compact'
echo "-- hook log:"; cat prune-spike.log 2>/dev/null || echo "(no log written)"
run 3 --resume "$id" 'How many Bash commands did you run earlier in this conversation, and what do you now see as the output of the first one? Answer in one sentence.'
