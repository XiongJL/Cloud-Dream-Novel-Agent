from __future__ import annotations

import asyncio

import pytest

from novel_agent_runtime.events import AgentEventBus
from novel_agent_runtime.intent.targets import extract_style_work_title, resolve_intent_chapter_target
from novel_agent_runtime.runtime import NovelAgentRuntime
from novel_agent_runtime.store import AgentStateStore
from test_runtime import FakeAutomationClient


HISTORY = "\n\n会话背景（仅用于理解当前任务）：\nAgent：按《历史作品》整本样本提炼文风 Skill Pack。"


@pytest.mark.parametrize("message,expected", [
    ("重新执行" + HISTORY, None),
    ("根据当前小说样本提炼文风 Skill Pack" + HISTORY, None),
    ("提炼《当前请求作品》的文风" + HISTORY, "当前请求作品"),
    ("根据当前选择的《当前作品》小说样本，提炼文风 Skill Pack", None),
    ("根据已导入的《当前作品》正文提炼文风 Skill Pack", None),
    ("提炼本书《当前作品》的文风", None),
    ("根据《外部作品》，提炼文风 Skill Pack", "外部作品"),
    ("不要读取当前项目正文，只根据《外部作品》提炼文风 Skill Pack", "外部作品"),
    ("不要使用模型先验，根据当前《本地作品》正文提炼文风 Skill Pack", None),
    ("审查《第一章》的逻辑", None),
])
def test_style_title_source_is_decided_by_current_request(message, expected):
    assert extract_style_work_title(message) == expected


def test_project_book_title_does_not_become_unresolved_chapter():
    target = resolve_intent_chapter_target(
        "根据当前选择的《本地作品》小说样本提炼文风 Skill Pack", [],
        editor_chapter_id="chapter_2", editor_volume_id="volume_1",
    )
    assert target.chapterId == "chapter_2"
    assert target.source == "current_reference"


@pytest.mark.parametrize("explicit_scope", [False, True])
def test_model_cannot_skip_project_samples_based_on_history(tmp_path, explicit_scope):
    async def scenario():
        automation = FakeAutomationClient()
        original = automation.invoke

        async def invoke(method, params, origin, request_id=None, **kwargs):
            if method == "agent.generate_plan":
                return {"title": "文风提炼", "deliverable": "report", "steps": [{
                    "agent": "writer", "title": "提炼文风", "tools": [],
                    "toolchain": {"id": "agent_skill.style_extract", "version": "1.0.0", "input": {
                        "sourceMode": "named_work_model_prior", "sourceWorkTitle": "历史作品",
                    }},
                }]}
            return await original(method, params, origin, request_id=request_id)

        automation.invoke = invoke
        store = AgentStateStore(tmp_path)
        runtime = NovelAgentRuntime(store, automation, AgentEventBus(store))
        params = {"goal": "根据当前小说样本提炼文风 Skill Pack" + HISTORY,
                  "role": "writer", "novelId": "novel_1", "chapterId": "chapter_2"}
        if explicit_scope:
            params["chapterScope"] = {"kind": "novel", "processingMode": "batched"}
        plan = await runtime.plan(params, {"locale": "zh-CN"})
        source = plan.steps[0].toolchain.input
        assert source["sourceMode"] == "project_chapter_scope"
        assert "sourceWorkTitle" not in source
        if explicit_scope:
            assert source["kind"] == "novel"
            assert source["processingMode"] == "batched"

    asyncio.run(scenario())
