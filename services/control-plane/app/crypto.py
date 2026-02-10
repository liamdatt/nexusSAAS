from __future__ import annotations

import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import get_settings


class SecretCipher:
    def __init__(self) -> None:
        settings = get_settings()
        if settings.secrets_master_key_b64:
            self._key = base64.b64decode(settings.secrets_master_key_b64)
            self.key_version = "v1"
        else:
            # Dev fallback for local environments.
            self._key = hashlib.sha256(b"nexus-saas-dev-key").digest()
            self.key_version = "dev-v1"
        if len(self._key) not in {16, 24, 32}:
            raise ValueError("SECRETS_MASTER_KEY_B64 must decode to 16/24/32 bytes")

    def encrypt(self, payload: dict) -> dict:
        aes = AESGCM(self._key)
        nonce = os.urandom(12)
        ciphertext = aes.encrypt(nonce, json.dumps(payload).encode("utf-8"), None)
        return {
            "nonce_b64": base64.b64encode(nonce).decode("ascii"),
            "ciphertext_b64": base64.b64encode(ciphertext).decode("ascii"),
        }

    def decrypt(self, encrypted_blob: dict) -> dict:
        aes = AESGCM(self._key)
        nonce = base64.b64decode(encrypted_blob["nonce_b64"])
        ciphertext = base64.b64decode(encrypted_blob["ciphertext_b64"])
        plaintext = aes.decrypt(nonce, ciphertext, None)
        return json.loads(plaintext.decode("utf-8"))
