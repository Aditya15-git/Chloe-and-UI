"""
agents/llm.py – AWS Bedrock (Claude Haiku) client.
"""
from __future__ import annotations
import asyncio
import json
import boto3
from src.config import get_settings
from src.services.cost_tracker import get_tracker

_cfg = get_settings()

_bedrock = boto3.client(
    "bedrock-runtime",
    region_name           = _cfg.aws_region,
    aws_access_key_id     = _cfg.aws_access_key_id,
    aws_secret_access_key = _cfg.aws_secret_access_key,
)


async def chat(messages: list[dict], system: str = "", max_tokens: int = 512) -> str:
    loop = asyncio.get_event_loop()
    try:
        text, in_tok, out_tok = await asyncio.wait_for(
            loop.run_in_executor(None, _invoke, messages, system, max_tokens),
            timeout=8.0   # never hang a call more than 8 seconds
        )
    except asyncio.TimeoutError:
        return "UNKNOWN"

    tracker = get_tracker()
    if tracker:
        tracker.add_llm_usage(in_tok, out_tok)

    return text


def _invoke(messages: list[dict], system: str, max_tokens: int) -> tuple[str, int, int]:
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens":        max_tokens,
        "messages":          messages,
    }
    if system:
        body["system"] = system

    resp = _bedrock.invoke_model(
        modelId     = _cfg.bedrock_model_id,
        body        = json.dumps(body),
        contentType = "application/json",
        accept      = "application/json",
    )
    result = json.loads(resp["body"].read())
    usage  = result.get("usage", {})
    return (
        result["content"][0]["text"].strip(),
        usage.get("input_tokens", 0),
        usage.get("output_tokens", 0),
    )
