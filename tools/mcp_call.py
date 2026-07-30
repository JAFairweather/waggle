#!/usr/bin/env python3
"""Call one tool on the nvoy MCP server, from a session that does not have it attached.

WHY THIS EXISTS: MCP toolsets are bound when a Claude Code session starts. A session that
began before `nvoy` was in ~/.claude.json never receives mcp__nvoy__* tools, and no amount of
ToolSearch will find them. `claude mcp list` still says "Connected" — that spawns the server to
health-check it. Connected is NOT attached. This speaks to the same tested server directly.

  ./mcp_call.py --list        args.json     # list tools + schemas
  ./mcp_call.py nvoy_whoami   args.json     # args.json = {}
  ./mcp_call.py nvoy_dm_send  args.json     # {"to": "<npub|hex>", "message": "..."}
  ./mcp_call.py nvoy_chat_post args.json    # {"content": "..."}  ← PUBLIC AND PERMANENT

Exits non-zero when the call fails, so a failure cannot read as success.
"""
import json, os, subprocess, sys, pathlib

SERVER = os.path.expanduser("~/Projects/nvoy/mcp/dist/server.js")
IDENT = os.path.expanduser("~/.nvoy/claude-identity.env")
TRUST = os.path.expanduser("~/.nvoy/trusted-senders.json")


def load_env():
    env = dict(os.environ)
    for line in pathlib.Path(IDENT).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    if "NVOY_NSEC" not in env:
        sys.exit("no NVOY_NSEC in " + IDENT)

    # Standing convention, stated in Claude's own kind:0 metadata: coordination DMs are CC-d to
    # the operator. NVOY_DM_CC is NOT in the identity file — every historical call set it on the
    # command line, and omitting it silently drops James off his own coordination. Resolved from
    # the trust allowlist rather than typed: an npub typed from memory has been corrupted here.
    if "NVOY_DM_CC" not in env:
        trusted = json.loads(pathlib.Path(TRUST).read_text())["trusted"]
        owner = [k for k, v in trusted.items() if "maintainer/owner" in v]
        if len(owner) != 1:
            sys.exit("cannot resolve exactly one operator from the trust allowlist")
        env["NVOY_DM_CC"] = owner[0]
    return env


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    tool, argfile = sys.argv[1], sys.argv[2]
    args = json.loads(pathlib.Path(argfile).read_text())

    p = subprocess.Popen(["node", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, env=load_env(), text=True, bufsize=1)

    def send(obj):
        p.stdin.write(json.dumps(obj) + "\n")
        p.stdin.flush()

    def read_id(want):
        while True:
            line = p.stdout.readline()
            if not line:
                sys.exit("server closed stdout before answering id=%s\n%s"
                         % (want, p.stderr.read()[:2000]))
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue          # server log lines are not protocol
            if msg.get("id") == want:
                return msg

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                     "clientInfo": {"name": "buzz-nest-direct", "version": "1"}}})
    read_id(1)
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    if tool == "--list":
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    else:
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
              "params": {"name": tool, "arguments": args}})
    resp = read_id(2)
    p.terminate()

    print(json.dumps(resp, indent=2))
    if resp.get("error") or resp.get("result", {}).get("isError"):
        sys.exit(1)


if __name__ == "__main__":
    main()
