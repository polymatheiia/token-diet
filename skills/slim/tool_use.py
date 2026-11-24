#!/usr/bin/env python3
"""Counts what a Claude Code profile actually uses over the main-session transcripts in
<config dir>/projects: tool calls (MCP servers grouped), Skill tool loads, and slash commands
(a slash command named after a skill is a load of that skill). Subagent transcripts are skipped.
Prints JSON. Usage: tool_use.py [config_dir] [days]"""
import json, os, re, sys, time
from collections import Counter

CMD = re.compile(r"<command-name>/?([^<\s]+)</command-name>")

cfg = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude"))
days = int(sys.argv[2]) if len(sys.argv) > 2 else 60
cut = time.time() - days * 86400
tools, servers, skills, commands, sessions = Counter(), Counter(), Counter(), Counter(), 0
seen = set()
root = os.path.join(cfg, "projects")


def text_of(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


for dp, dirs, fs in os.walk(root):
    dirs[:] = [d for d in dirs if d != "subagents"]
    for f in fs:
        if not f.endswith(".jsonl"):
            continue
        p = os.path.join(dp, f)
        if os.path.getmtime(p) < cut:
            continue
        sessions += 1
        with open(p, errors="replace") as fh:
            for line in fh:
                has_tool, has_cmd = '"tool_use"' in line, "<command-name>" in line
                if not (has_tool or has_cmd):
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                kind = d.get("type")
                c = (d.get("message") or {}).get("content")
                # Only the turn's own record counts: request blobs repeat earlier history.
                if has_tool and kind == "assistant" and isinstance(c, list):
                    for b in c:
                        if not isinstance(b, dict) or b.get("type") != "tool_use":
                            continue
                        key = b.get("id") or (p, d.get("uuid"), b.get("name"))
                        if key in seen:
                            continue
                        seen.add(key)
                        n = b.get("name", "")
                        tools[n] += 1
                        if n.startswith("mcp__"):
                            servers[n.split("__")[1]] += 1
                        if n == "Skill":
                            skills[str((b.get("input") or {}).get("skill", ""))] += 1
                if has_cmd and kind == "user":
                    m = CMD.search(text_of(c))
                    key = d.get("uuid") or (p, line)
                    if m and key not in seen:
                        seen.add(key)
                        commands[m.group(1)] += 1
print(json.dumps({"config": cfg, "days": days, "sessions": sessions,
                  "tools": tools.most_common(), "mcp_servers": servers.most_common(),
                  "skills": skills.most_common(), "slash_commands": commands.most_common()}, indent=1))
