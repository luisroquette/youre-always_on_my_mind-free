# Security policy

Never commit databases, vector indexes, models, memory exports, logs, tokens
or credentials. Do not open public issues containing credentials, private memory
exports, or other sensitive data.

If you expose the local dashboard remotely, it must:

1. require authentication;
2. run with `MEMORY_GATEWAY_REMOTE_READONLY=1` whenever writes are not needed;
3. stay behind HTTPS;
4. keep the database only on the local host.

Revoke or rotate credentials with your platform's own secret-management tool.
The public project does not prescribe an account, service name or remote host.

To report a security concern, use GitHub's private security advisory for this
repository. Include only the minimum detail needed to reproduce the issue. If
private reporting is unavailable, open a minimal issue asking for a private
contact channel.

Before publishing any change, run the public-release validation and review the
complete diff.
