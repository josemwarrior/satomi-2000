# Security Policy

Please report security issues privately to the project maintainer. Do not open a public issue containing access tokens, app passwords, private filesystem paths, publication state, or API response bodies tied to a real account.

Satomi does not require credentials in its YAML configuration. Keep secrets in environment variables, a mode-`600` ignored `.env` file, or macOS Keychain. Rotate a credential immediately if it is committed, printed, or shared accidentally.
