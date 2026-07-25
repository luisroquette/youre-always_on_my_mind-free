# Security policy

Never commit databases, vector indexes, models, memory exports, logs, tokens
or credentials.

If you expose the local dashboard remotely, it must:

1. require authentication;
2. run with `MEMORY_GATEWAY_REMOTE_READONLY=1` whenever writes are not needed;
3. stay behind HTTPS;
4. keep the database only on the local host.

Revoke or rotate credentials with your platform's own secret-management tool.
The public project does not prescribe an account, service name or remote host.
