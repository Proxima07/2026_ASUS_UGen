"""Export contracts from the running backend's schema definitions."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
from app.schemas import ActionEnvelope, ActionResult, BridgeProtocol, TOOL_ARGS
from pydantic import TypeAdapter

contracts = root / "contracts"
contracts.mkdir(exist_ok=True)
for filename, model in (("action.schema.json", ActionEnvelope), ("result.schema.json", ActionResult)):
    schema = model.model_json_schema()
    if model is ActionEnvelope:
        schema["x-tool-arguments"] = {k: v.model_json_schema() for k, v in TOOL_ARGS.items()}
    (contracts / filename).write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(contracts / "bridge.schema.json").write_text(json.dumps(TypeAdapter(BridgeProtocol).json_schema(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
examples = contracts / "examples"
examples.mkdir(exist_ok=True)
(examples / "contacts-search.json").write_text(json.dumps({"kind": "contacts.search", "payload": {"query": "媽媽", "purpose": "dial"}, "state": "pending_confirmation"}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(examples / "dial-result.json").write_text(json.dumps({"execution_token": "example-execution-token-replace-with-confirm-response", "state": "opened", "result": {}}, indent=2) + "\n", encoding="utf-8")
print("Exported contracts to", contracts)
