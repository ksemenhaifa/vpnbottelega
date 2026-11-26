"""Generate a value for PANEL_PASSWORD_HASH: python -m app.hashpw"""
from __future__ import annotations

import getpass
import sys

from .auth import hash_password


def main() -> int:
    password = getpass.getpass("Пароль панели: ")
    if len(password) < 10:
        print("Пароль должен быть не короче 10 символов.", file=sys.stderr)
        return 1
    if password != getpass.getpass("Ещё раз: "):
        print("Пароли не совпали.", file=sys.stderr)
        return 1
    print(hash_password(password))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
