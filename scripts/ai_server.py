import json
import os
from flask import Flask, jsonify, request
from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import SystemMessage, UserMessage
from azure.core.credentials import AzureKeyCredential

app = Flask(__name__)

ENDPOINT = "https://models.github.ai/inference"
MODEL = os.environ.get("GITHUB_MODEL", "openai/gpt-4.1")
TOKEN = os.environ.get("GITHUB_TOKEN")

if not TOKEN:
    raise RuntimeError("Missing GITHUB_TOKEN environment variable.")

client = ChatCompletionsClient(
    endpoint=ENDPOINT,
    credential=AzureKeyCredential(TOKEN),
)


@app.post("/api/ai-report")
def ai_report():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()
    report = payload.get("report") or {}

    if not question:
        return jsonify({"error": "Missing question"}), 400

    report_text = json.dumps(report, ensure_ascii=False, indent=2)
    messages = [
        SystemMessage(
            "You are a music practice assistant. Provide concise, actionable feedback in Chinese."
        ),
        UserMessage(
            "以下是演奏报告(JSON)：\n"
            f"{report_text}\n\n"
            "用户问题：\n"
            f"{question}\n\n"
            "请给出要点清晰、可执行的建议。"
        ),
    ]

    response = client.complete(
        messages=messages,
        temperature=0.7,
        top_p=0.9,
        model=MODEL,
    )

    answer = response.choices[0].message.content
    return jsonify({"answer": answer})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False)
