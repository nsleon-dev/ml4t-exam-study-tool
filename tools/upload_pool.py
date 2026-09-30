"""Upload private/questions.json to Supabase so signed-in users can load it.

Usage (the service-role key is secret — keep it out of the repo and the site):
    export SUPABASE_URL="https://<project>.supabase.co"
    export SUPABASE_SERVICE_ROLE_KEY="<secret key (sb_secret_…) or legacy service_role key, from Project Settings → API Keys>"
    python tools/upload_pool.py

Re-run after regenerating the pool; clients re-download only when the content changes.
"""
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "private" / "questions.json"


def main():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (see the docstring).")
    if not SRC.exists():
        sys.exit(f"{SRC} not found. Run tools/parse_pool.py first.")

    raw = SRC.read_bytes()
    data = json.loads(raw)
    version = hashlib.sha256(raw).hexdigest()[:16]
    body = json.dumps({"id": "current", "version": version, "data": data}).encode()

    req = urllib.request.Request(
        f"{url}/rest/v1/question_pool?on_conflict=id",
        data=body,
        method="POST",
        headers={
            "apikey": key,
            # Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys
            # are not JWTs and must only be sent as `apikey`.
            **({} if key.startswith("sb_") else {"Authorization": f"Bearer {key}"}),
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"Upload failed ({e.code}): {e.read().decode(errors='replace')}")
    print(f"Uploaded {len(data['questions'])} questions ({len(raw) / 1e6:.1f} MB), version {version}.")


if __name__ == "__main__":
    main()
