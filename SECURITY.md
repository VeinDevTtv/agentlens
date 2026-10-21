# Security

AgentLens reads local session logs and never sends data over the network. The main risks are therefore local: a malicious log file crashing the parser, or transcript content leaking through screenshots and bug reports.

If you find a vulnerability (for example, a crafted JSONL record that executes code or escapes the sandboxed renderer), please report it privately through GitHub's "Report a vulnerability" button on the Security tab rather than a public issue. You will get a response within a week.
