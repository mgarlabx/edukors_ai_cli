# Security

Please report vulnerabilities privately to the maintainers (security contact to be defined before publication). Do not open a public issue. Include the affected version, platform and steps to reproduce. Never include real credentials.

Design rules this project relies on:

- Credentials stay in provider-managed storage. The shared registry holds only non-secret metadata.
- Provider processes receive an allowlisted environment.
- Diagnostics are redacted when they are recorded and exclude document content.
- Tools enforce scope at the application boundary, not through prompts.
