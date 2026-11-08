"""Export the /ws/campus JSON schema (by-alias, i.e. the wire names).

Used by ``frontend/tests/contractsDrift.test.ts`` to detect drift between the
hand-written ``frontend/src/engine/contracts.ts`` and the backend models.

    uv run python tests/export_campus_schema.py > schema.json
"""

import json
import sys

from app.models.campus import CampusState


def export() -> dict[str, object]:
    return CampusState.model_json_schema(by_alias=True, mode="serialization")


if __name__ == "__main__":
    json.dump(export(), sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")
