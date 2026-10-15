import base64
import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from flask import g, jsonify, request

from app import create_app
from app import agent_plugin as agent
from app.routes import api


@pytest.fixture
def app(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH_ENABLE", "0")
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.setenv("AGENT_PLUGIN_ENABLE", "1")
    monkeypatch.setenv("USERS_FILE", str(tmp_path / "users.json"))
    application = create_app()
    application.config.update(TESTING=True)
    yield application
    queue = application.extensions.get("action_queue")
    if queue:
        queue.close()


@pytest.fixture
def harness(app, monkeypatch):
    entries = [
        {"index": 1, "name": "student-one", "vmid": 101, "node": "node1", "type": "qemu"},
        {"index": 2, "name": "student-two", "vmid": 102, "node": "node1", "type": "lxc"},
    ]
    project = SimpleNamespace(
        id="p",
        proxmox_api_token="proxmox-token",
        credentials=[{"username": "student/one"}, {"username": "student.two"}],
    )
    client = MagicMock()

    def context(pid, body, **kwargs):
        selected = [entry for entry in entries if any(t["index"] == entry["index"] for t in body["targets"])]
        return project, client, "https://proxmox", "remote-password", selected, [], []

    monkeypatch.setattr(api, "_guest_transfer_context", context)
    monkeypatch.setattr(api, "_block_when_remote", lambda feature: None)
    body = {
        "llm": {"url": "http://llm:8080/v1", "model": "test", "api_key": "llm-key"},
        "prompt": "Grade without modifying files",
        "assignment": "# Assignment\nCheck x.py",
        "password": "remote-password",
        "targets": [{"index": 1, "name": "student-one"}],
    }
    return app.test_client(), body, entries, client


def completion(name, args, call_id="call1"):
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                    ],
                }
            }
        ]
    }


def rubric(status="pass"):
    return {
        "summary": "Checked x.py",
        "criteria": [
            {
                "criterion": "Required file",
                "status": status,
                "score": 10 if status == "pass" else 0,
                "max_score": 10,
                "evidence": "test -f /home/student/x.py exited 0",
                "feedback": "Correct location",
            }
        ],
    }


def fake_llm(monkeypatch, *responses):
    calls = []
    responses = iter(responses)

    def invoke(cfg, resource, payload=None, **kwargs):
        calls.append(json.loads(json.dumps(payload)))
        return next(responses)

    monkeypatch.setattr(agent, "llm_request", invoke)
    return calls


def test_disabled_plugin_has_no_routes(monkeypatch, tmp_path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AGENT_PLUGIN_ENABLE", "0")
    app = create_app()
    client = app.test_client()
    assert client.get("/api/plugins").get_json() == {"plugins": []}
    assert client.post("/api/plugins/agent/models", json={}).status_code == 404
    assert client.post("/api/plugins/agent/collective", json={}).status_code == 404
    assert client.post("/api/projects/p/instances/actions/agent", json={}).status_code == 404


@pytest.mark.parametrize(
    "url, expected",
    [
        ("http://localhost:1234", "http://localhost:1234/v1"),
        ("https://llm/gateway/v1/", "https://llm/gateway/v1"),
        ("http://[::1]:8080/v1/chat/completions", "http://[::1]:8080/v1"),
    ],
)
def test_endpoint_paths(url, expected):
    assert agent.endpoint_url(url) == expected


@pytest.mark.parametrize(
    "url", ["file:///tmp/key", "ftp://llm", "https://user:key@llm", "https://llm?key=x", "https://llm:bad"]
)
def test_invalid_endpoint(url):
    with pytest.raises(ValueError):
        agent.endpoint_url(url)


def test_catalog_fetch_and_request_configuration(app, monkeypatch):
    response = MagicMock(status_code=200)
    response.json.return_value = {"data": [{"id": "b"}, {"id": "a"}, {"id": "a"}]}
    request_mock = MagicMock(return_value=response)
    monkeypatch.setattr(agent.requests, "request", request_mock)
    result = app.test_client().post(
        "/api/plugins/agent/models",
        json={"url": "https://llm/v1", "api_key": "key", "ssl_verify": False, "request_timeout": 42},
    )
    assert result.get_json() == {"models": ["a", "b"], "model_limits": {"a": {}, "b": {}}}
    discovery = request_mock.call_args_list[0]
    assert discovery.args == ("GET", "https://llm/v1/models")
    assert discovery.kwargs["verify"] is False
    assert discovery.kwargs["headers"]["Authorization"] == "Bearer key"
    assert discovery.kwargs["timeout"] == (10, 42)
    assert discovery.kwargs["allow_redirects"] is False


def test_grade_selected_guest_and_keep_archive(harness, monkeypatch):
    client, body, entries, proxmox = harness
    calls = fake_llm(
        monkeypatch,
        completion("run_command", {"command": "test -f /home/student/x.py"}),
        completion("submit_rubric", rubric()),
    )
    proxmox.agent_exec.return_value = {
        "exitcode": 0,
        "stdout": "present remote-password llm-key proxmox-token",
        "stderr": "",
    }
    response = client.post("/api/projects/p/instances/actions/agent", json=body)
    assert response.status_code == 200
    result = response.get_json()
    assert len(result["reports"]) == 1
    assert result["reports"][0]["score"] == 10
    assert result["reports"][0]["status"] == "completed"
    assert not result["agent_failed"]
    assert proxmox.agent_exec.call_args.kwargs["vmid"] == 101
    assert proxmox.agent_exec.call_args.kwargs["timeout"] == 60
    assert calls[1]["messages"][-1]["role"] == "tool"
    assert calls[1]["messages"][-1]["tool_call_id"] == "call1"
    assert body["assignment"] in calls[0]["messages"][1]["content"]
    for secret in ("remote-password", "llm-key", "proxmox-token"):
        assert secret not in json.dumps(calls)
        assert secret not in result["markdown"]
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        assert "rubrics.md" in archive.namelist()
        assert "results.html" in archive.namelist()
        page = archive.read("results.html").decode()
        assert "Checked x.py" in page
        prefix = "student-one-101_student_one"
        assert f"./{prefix}/report.json" in page
        assert f"{prefix}/transcript.json" in archive.namelist()
        assert "remote-password" not in archive.read(f"{prefix}/transcript.json").decode()
        assert f"{prefix}/rubric.md" in archive.namelist()
        assert f"{prefix}/report.json" in archive.namelist()
        assert "STDOUT:" in archive.read(f"{prefix}/output.log").decode()


def test_vm_and_lxc_have_independent_conversations(harness, monkeypatch):
    client, body, entries, _ = harness
    body["targets"].append({"index": 2, "name": "student-two"})
    calls = fake_llm(
        monkeypatch,
        completion("run_command", {"command": "hostname"}),
        completion("submit_rubric", rubric()),
        completion("run_command", {"command": "hostname"}),
        completion("submit_rubric", rubric("fail")),
    )
    execute = MagicMock(return_value={"exitcode": 0, "stdout": "ok", "stderr": ""})
    monkeypatch.setattr(api, "_execute_instance_command", execute)
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert [r["vmid"] for r in result["reports"]] == [101, 102]
    assert len(calls[0]["messages"]) == len(calls[2]["messages"]) == 2
    assert execute.call_args_list[0].args[4]["type"] == "qemu"
    assert execute.call_args_list[1].args[4]["type"] == "lxc"
    assert not result["agent_failed"]  # A failing submission is a completed grade.


def test_collective_conversation_spans_projects_and_targets_only_selected_guests(harness, monkeypatch):
    client, body, entries, _ = harness
    projects = {
        "p": (SimpleNamespace(id="p", proxmox_api_token="token-p", credentials=[]), entries[0]),
        "other": (SimpleNamespace(id="other", proxmox_api_token="token-other", credentials=[]), entries[1]),
    }

    def context(pid, payload, **kwargs):
        project, entry = projects[pid]
        assert payload["targets"] == [{"index": entry["index"], "name": entry["name"]}]
        return project, MagicMock(), "https://proxmox", "remote-password", [entry], [], []

    monkeypatch.setattr(api, "_guest_transfer_context", context)
    execute = MagicMock(side_effect=[
        {"exitcode": 0, "stdout": "version A", "stderr": ""},
        {"exitcode": 0, "stdout": "version B", "stderr": ""},
    ])
    monkeypatch.setattr(api, "_execute_instance_command", execute)
    calls = fake_llm(
        monkeypatch,
        completion("run_command", {"guest_id": "g1", "command": "cat /etc/version"}),
        completion("run_command", {"guest_id": "g2", "command": "cat /etc/version"}),
        completion("submit_result", {"summary": "Versions differ across projects", "guests": [
            {"guest_id": "g1", "status": "completed", "summary": "Version A"},
            {"guest_id": "g2", "status": "completed", "summary": "Version B"},
        ]}),
    )
    response = client.post("/api/plugins/agent/collective", json={
        "llm": body["llm"], "prompt": "Compare versions", "assignment": "",
        "groups": [
            {"projectId": "p", "password": "remote-password", "targets": [{"index": 1, "name": "student-one", "vmid": 999}]},
            {"projectId": "other", "password": "remote-password", "targets": [{"index": 2, "name": "student-two"}]},
        ],
    })
    assert response.status_code == 200
    result = response.get_json()
    assert result["summary"] == "Versions differ across projects"
    assert [report["summary"] for report in result["reports"]] == ["Version A", "Version B"]
    assert [call.args[0].id for call in execute.call_args_list] == ["p", "other"]
    assert len(calls[0]["messages"]) == 2
    assert "version A" in json.dumps(calls[2]["messages"])
    assert "version B" in json.dumps(calls[2]["messages"])
    assert all("remote-password" not in json.dumps(call) for call in calls)
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        assert "shared_transcript.json" in archive.namelist()
        assert "summary.md" in archive.namelist()
        assert any(name.startswith("project-2-other/g2-") and name.endswith("/report.json") for name in archive.namelist())


def test_collective_rejects_unselected_guest_tool_target(harness, monkeypatch):
    client, body, _, _ = harness
    execute = MagicMock()
    monkeypatch.setattr(api, "_execute_instance_command", execute)
    calls = fake_llm(
        monkeypatch,
        completion("run_command", {"guest_id": "g999", "command": "hostname"}),
        completion("submit_result", {"summary": "Could not inspect", "guests": [
            {"guest_id": "g1", "status": "incomplete", "summary": "Not inspected"},
        ]}),
    )
    response = client.post("/api/plugins/agent/collective", json={
        "llm": body["llm"], "prompt": "Inspect hostname", "assignment": "",
        "groups": [{"projectId": "p", "password": "remote-password", "targets": body["targets"]}],
    })
    assert response.status_code == 200
    assert response.get_json()["reports"][0]["status"] == "incomplete"
    assert calls[1]["messages"][-1]["content"] == '{"error": "Guest is not in the selected set"}'
    execute.assert_not_called()


def test_collective_queue_tracks_guests_across_projects(app, monkeypatch):
    from app.action_queue import ActionQueue

    monkeypatch.setattr(ActionQueue, "start", lambda self: None)
    with app.test_request_context("/api/queue", method="POST"):
        queue = ActionQueue(app)
        row = queue.submit("local", {"token": "shared-test", "label": "Run agent", "projectId": "p", "steps": [{
            "method": "POST", "url": "/api/plugins/agent/collective", "body": {"groups": [
                {"projectId": "p", "targets": [{"index": 1, "name": "one", "type": "qemu"}]},
                {"projectId": "other", "targets": [{"index": 2, "name": "two", "type": "lxc"}]},
            ]},
        }]}, [])
    state = json.loads(row["agent_state"])
    assert state["enabled"] is True
    assert [(target["projectId"], target["name"]) for target in state["targets"]] == [
        ("p", "one"), ("other", "two")
    ]


def test_collective_queue_retains_overall_and_guest_results(harness, monkeypatch):
    from app.action_queue import ActionQueue, retained_agent_results

    client, body, _, proxmox = harness
    proxmox.agent_exec.return_value = {"exitcode": 0, "stdout": "node1", "stderr": ""}
    fake_llm(
        monkeypatch,
        completion("run_command", {"guest_id": "g1", "command": "hostname"}),
        completion("submit_result", {"summary": "One host inspected", "guests": [
            {"guest_id": "g1", "status": "completed", "summary": "Hostname is node1"},
        ]}),
    )
    monkeypatch.setattr(ActionQueue, "start", lambda self: None)
    queue = ActionQueue(client.application)
    with client.application.test_request_context("/api/queue", method="POST"):
        row = queue.submit("local", {"token": "collective-retain", "label": "Run agent", "projectId": "p", "steps": [{
            "method": "POST", "url": "/api/plugins/agent/collective", "body": {
                "llm": body["llm"], "prompt": "Check hostname", "assignment": "",
                "groups": [{"projectId": "p", "password": "remote-password", "targets": body["targets"]}],
            },
        }]}, [])
    queue.execute(row)
    with queue.connect() as db:
        completed = db.execute("SELECT * FROM actions WHERE id=?", (row["id"],)).fetchone()
    assert completed["status"] == "completed"
    retained = retained_agent_results(completed)
    assert retained["summary"] == "One host inspected"
    assert retained["reports"][0]["summary"] == "Hostname is node1"
    assert len(retained["archives"]) == 1


def test_push_uses_only_supplied_attachment_and_selected_target(harness, monkeypatch):
    client, body, entries, _ = harness
    fake_llm(
        monkeypatch,
        completion("push_file", {"path": "/tmp/test.py", "upload": "test.py"}),
        completion("submit_rubric", rubric("unknown")),
    )
    observed = []

    def push(pid):
        payload = json.loads(request.form["payload"])
        observed.append((payload, request.files["files"].read(), g.guest_push_upload_keys))
        return jsonify(pushed=[{"vmid": 101}], errors=[])

    monkeypatch.setattr(api, "instances_lxc_push", push)
    response = client.post(
        "/api/projects/p/instances/actions/agent",
        data={"payload": json.dumps(body), "files": (io.BytesIO(b'print("test")'), "test.py")},
    )
    assert response.status_code == 200
    assert observed[0][0]["targets"] == [entries[0]]
    assert observed[0][0]["destination"] == "/tmp"
    assert observed[0][1] == b'print("test")'
    assert response.get_json()["agent_failed"]


def test_pull_preserves_full_files_and_bounds_preview(harness, monkeypatch):
    client, body, entries, _ = harness
    fake_llm(
        monkeypatch, completion("pull_files", {"paths": ["/home/student/x.py"]}), completion("submit_rubric", rubric())
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("student-one/x.py", "x" * 10000)

    def pull(pid):
        assert request.json["targets"] == [entries[0]]
        return jsonify(
            pulled=[{"file_count": 1}], errors=[], outputs_zip={"base64": base64.b64encode(buffer.getvalue()).decode()}
        )

    monkeypatch.setattr(api, "instances_lxc_pull", pull)
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    preview = result["reports"][0]["log"][0]["result"]["files"][0]
    assert len(preview["preview"]) == 4096
    assert preview["truncated"]
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as z:
        assert z.read("student-one-101_student_one/pulled/01/x.py") == b"x" * 10000
        assert not any(name.endswith(".zip") for name in z.namelist())


def test_unknown_tools_extra_target_and_excessive_timeout_never_execute(harness, monkeypatch):
    client, body, _, proxmox = harness
    fake_llm(
        monkeypatch,
        completion("run_command", {"command": "hostname", "vmid": 999}),
        completion("run_command", {"command": "hostname", "timeout": 999}),
        completion("ssh_host", {"host": "other-host"}),
        completion("submit_rubric", rubric("unknown")),
    )
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert proxmox.agent_exec.call_count == 0
    assert all("error" in r["result"] for r in result["reports"][0]["log"][:3])
    assert result["reports"][0]["status"] == "incomplete"


def test_turn_limit_forces_final_rubric_without_more_commands(harness, monkeypatch):
    client, body, _, proxmox = harness
    body["llm"]["max_turns"] = 1
    proxmox.agent_exec.return_value = {"exitcode": 0, "stdout": "", "stderr": ""}
    calls = fake_llm(
        monkeypatch, completion("run_command", {"command": "hostname"}), completion("submit_rubric", rubric())
    )
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert len(calls[1]["tools"]) == 1
    assert calls[1]["tool_choice"]["function"]["name"] == "submit_rubric"
    assert result["reports"][0]["status"] == "incomplete"


def test_bad_rubric_does_not_accept_fabricated_grade(harness, monkeypatch):
    client, body, _, proxmox = harness
    fake_llm(monkeypatch, completion("submit_rubric", rubric()), completion("submit_rubric", rubric("unknown")))
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert "Run an inspection" in result["reports"][0]["log"][0]["result"]["error"]
    assert result["reports"][0]["status"] == "incomplete"
    assert proxmox.agent_exec.call_count == 0


@pytest.mark.parametrize(
    "args",
    [
        {"summary": "x", "criteria": [{**rubric()["criteria"][0], "score": 11}]},
        {"summary": "x", "criteria": [{**rubric()["criteria"][0], "score": float("nan")}]},
        {"summary": "x", "criteria": []},
    ],
)
def test_invalid_rubric(args):
    with pytest.raises(ValueError):
        agent.validate_arguments("submit_rubric", args)


def test_cancel_between_tools(app):
    cfg = agent.configuration({"url": "http://llm", "model": "test"})
    tools = MagicMock()
    result = agent.run_guest(cfg, "grade", "", {"name": "one"}, {}, tools, lambda: True, lambda v: None, [])
    assert result["status"] == "cancelled"
    tools.assert_not_called()


def test_compaction_keeps_tool_call_pairs():
    cfg = agent.configuration({"url": "http://llm", "model": "test", "context_window": 4096, "max_tokens": 512})
    messages = [{"role": "system", "content": agent.SYSTEM_PROMPT}, {"role": "user", "content": "grade"}]
    for index in range(4):
        messages += [
            {"role": "assistant", "tool_calls": [{"id": str(index)}], "content": None},
            {"role": "tool", "tool_call_id": str(index), "content": "x" * 2500},
        ]
    agent.compact_messages(messages, cfg)
    assert len(messages) < 10
    for index, message in enumerate(messages):
        if message["role"] == "tool":
            assert messages[index - 1]["tool_calls"][0]["id"] == message["tool_call_id"]


def test_auth_and_api_key_enforced(app):
    client = app.test_client()
    app.config["AUTH_ENABLE"] = True
    assert client.post("/api/plugins/agent/models", json={}).status_code == 401
    app.config["AUTH_ENABLE"] = False
    app.config["API_KEY"] = "server-key"
    assert client.post("/api/projects/p/instances/actions/agent", json={}).status_code == 401
    assert client.post("/api/plugins/agent/models", json={}, headers={"X-API-Key": "server-key"}).status_code == 400


def test_queue_retains_all_project_reports_and_erases_request_secrets(harness, monkeypatch):
    from app.action_queue import ActionQueue

    client, body, _, _ = harness
    monkeypatch.setattr(ActionQueue, "start", lambda self: None)
    monkeypatch.setattr(ActionQueue, "schedule_refreshes", lambda *args: None)
    fake_llm(
        monkeypatch, completion("submit_rubric", rubric("unknown")), completion("submit_rubric", rubric("unknown"))
    )
    job = client.post(
        "/api/queue",
        json={
            "token": "agent-test",
            "label": "Run agent",
            "projectId": "p",
            "steps": [
                {"method": "POST", "url": f"/api/projects/{pid}/instances/actions/agent", "body": body}
                for pid in ("p", "q")
            ],
        },
    ).get_json()
    queue = client.application.extensions["action_queue"]
    queue.execute(queue.claim())
    state = client.get(f"/api/queue/{job['id']}").get_json()
    assert state["status"] == "error"
    result = client.get(f"/api/queue/{job['id']}/result").get_json()
    assert len(result["results"]) == 2
    assert all(item["outputs_zip"]["base64"] for item in result["results"])
    log = client.get(f"/api/queue/{job['id']}/log").get_data(as_text=True)
    assert "Required file" in log
    assert "remote-password" not in log
    with queue.connect() as db:
        assert db.execute("SELECT payload FROM actions WHERE id=?", (job["id"],)).fetchone()[0] is None


def test_generated_pushes_with_same_name_get_distinct_cache_keys(harness, monkeypatch):
    client, body, _, _ = harness
    fake_llm(
        monkeypatch,
        completion("push_file", {"path": "/tmp/test.py", "content": "first"}),
        completion("push_file", {"path": "/tmp/test.py", "content": "second"}),
        completion("submit_rubric", rubric("unknown")),
    )
    keys = []

    def push(pid):
        keys.append(g.guest_push_upload_keys)
        return jsonify(pushed=[{"vmid": 101}], errors=[])

    monkeypatch.setattr(api, "instances_lxc_push", push)
    client.post("/api/projects/p/instances/actions/agent", json=body)
    assert len(keys) == 2 and keys[0] != keys[1]


def test_pinned_inventory_ignores_forged_guest_ids(harness, monkeypatch):
    client, body, _, proxmox = harness
    body["targets"][0].update(vmid=999, node="unselected")
    fake_llm(monkeypatch, completion("run_command", {"command": "hostname"}), completion("submit_rubric", rubric()))
    proxmox.agent_exec.return_value = {"exitcode": 0, "stdout": "", "stderr": ""}
    client.post("/api/projects/p/instances/actions/agent", json=body)
    assert proxmox.agent_exec.call_args.kwargs["vmid"] == 101
    assert proxmox.agent_exec.call_args.kwargs["node"] == "node1"


def test_real_qemu_push_handler_receives_attachment(harness, monkeypatch):
    client, body, _, _ = harness
    original_context = api._guest_transfer_context

    def token_context(*args, **kwargs):
        context = list(original_context(*args, **kwargs))
        context[3] = None
        return tuple(context)

    monkeypatch.setattr(api, "_guest_transfer_context", token_context)
    fake_llm(
        monkeypatch,
        completion("push_file", {"path": "/tmp/test.py", "upload": "test.py"}),
        completion("submit_rubric", rubric("unknown")),
    )
    monkeypatch.setattr(api, "_start_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(api, "_end_job", lambda *args, **kwargs: None)
    monkeypatch.setattr(api, "_is_cancelled", lambda pid: False)
    monkeypatch.setattr(api, "_project_max_jobs", lambda proj: 1)
    captured = []

    def push(client, entry, stream, size, destination, owner):
        import tarfile

        with tarfile.open(fileobj=stream) as tar:
            captured.append(tar.extractfile("test.py").read())

    monkeypatch.setattr(api, "_push_tar_through_guest_agent", push)
    response = client.post(
        "/api/projects/p/instances/actions/agent",
        data={"payload": json.dumps(body), "files": (io.BytesIO(b'print("actual")'), "test.py")},
    )
    assert captured == [b'print("actual")'], response.get_json()


def test_archive_groups_vm_and_lxc_reports_like_pull(harness, monkeypatch):
    client, body, entries, _ = harness
    body["targets"].append({"index": 2, "name": "student-two"})
    fake_llm(
        monkeypatch, completion("submit_rubric", rubric("unknown")), completion("submit_rubric", rubric("unknown"))
    )
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        for entry, username in zip(entries, ["student/one", "student.two"]):
            prefix = api._lxc_zip_prefix(entry["name"], entry["vmid"], username)
            for filename in ("rubric.md", "report.json", "transcript.json", "output.log"):
                assert f"{prefix}/{filename}" in archive.namelist()
            report = json.loads(archive.read(f"{prefix}/report.json"))
            assert report["vmid"] == entry["vmid"]
            assert report["type"] == entry["type"]
            assert report["username"] == username


def test_unresolved_and_cancelled_guests_keep_own_logs(harness, monkeypatch):
    client, body, entries, proxmox = harness
    project = SimpleNamespace(id="p", proxmox_api_token="", credentials=[{"username": "student/one"}])
    monkeypatch.setattr(
        api,
        "_guest_transfer_context",
        lambda *args, **kwargs: (
            project,
            proxmox,
            "https://proxmox",
            "remote-password",
            entries[:1],
            [{"name": "missing-vm", "index": 3, "reason": "not found"}],
            [],
        ),
    )
    with client.application.test_request_context("/api/projects/p/instances/actions/agent", method="POST", json=body):
        g.action_queue_cancelled = lambda: True
        response = client.application.full_dispatch_request()
        result = response.get_json()
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        assert "missing-vm-unresolved-1/output.log" in archive.namelist()
        assert "not found" in archive.read("missing-vm-unresolved-1/output.log").decode()
        assert "student-one-101_student_one/output.log" in archive.namelist()
        assert "Status: cancelled" in archive.read("student-one-101_student_one/output.log").decode()
    proxmox.agent_exec.assert_not_called()


def test_pulled_evidence_rejects_parent_traversal(harness, monkeypatch):
    client, body, _, _ = harness
    fake_llm(
        monkeypatch, completion("pull_files", {"paths": ["/tmp/x"]}), completion("submit_rubric", rubric("unknown"))
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("student-one/../../outside.txt", b"unsafe")
    monkeypatch.setattr(
        api,
        "instances_lxc_pull",
        lambda pid: jsonify(pulled=[], outputs_zip={"base64": base64.b64encode(buffer.getvalue()).decode()}),
    )
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert result["reports"][0]["log"][0]["result"]["error"] == "Unsafe path in pulled evidence archive"
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        assert not any("outside.txt" in name for name in archive.namelist())


@pytest.mark.parametrize("cancel_run", [False, True])
def test_real_sse_transcript_is_available_while_queue_runs(harness, monkeypatch, cancel_run):
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from app.action_queue import ActionQueue

    client, body, _, proxmox = harness
    proxmox.agent_exec.return_value = {"exitcode": 0, "stdout": "file exists", "stderr": ""}
    monkeypatch.setattr(ActionQueue, "schedule_refreshes", lambda *args: None)
    release, streaming = threading.Event(), threading.Event()
    requests_seen = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests_seen.append(payload)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def send(value):
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()

            try:
                if len(requests_seen) == 1:
                    send(
                        {
                            "choices": [
                                {"index": 0, "delta": {"reasoning_content": "Checking required file locations. " * 8}}
                            ]
                        }
                    )
                    streaming.set()
                    assert release.wait(5)
                    send(
                        {
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "call1",
                                                "function": {"name": "run_command", "arguments": '{"command":'},
                                            }
                                        ]
                                    },
                                }
                            ]
                        }
                    )
                    send(
                        {
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "tool_calls": [
                                            {"index": 0, "function": {"arguments": '"test -f /home/student/x.py"}'}}
                                        ]
                                    },
                                    "finish_reason": "tool_calls",
                                }
                            ]
                        }
                    )
                else:
                    send({"choices": [{"index": 0, "delta": {"content": "The required file exists."}}]})
                    send(
                        {
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": 0,
                                                "id": "call2",
                                                "function": {
                                                    "name": "submit_rubric",
                                                    "arguments": json.dumps(rubric()),
                                                },
                                            }
                                        ]
                                    },
                                    "finish_reason": "tool_calls",
                                }
                            ]
                        }
                    )
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    body["llm"]["url"] = f"http://127.0.0.1:{server.server_port}/v1"
    job = client.post(
        "/api/queue",
        json={
            "token": "live-sse",
            "label": "Run agent",
            "projectId": "p",
            "steps": [{"method": "POST", "url": "/api/projects/p/instances/actions/agent", "body": body}],
        },
    ).get_json()
    try:
        assert streaming.wait(3)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            live = client.get(job["liveTranscriptUrl"]).get_json()
            if any(event["kind"] == "reasoning" for event in live["events"]):
                break
            time.sleep(0.01)
        else:
            pytest.fail("Reasoning was not published before the model response finished")
        assert live["job"]["status"] == "running"
        assert any(event["kind"] == "prompt" and body["prompt"] in event["text"] for event in live["events"])
        assert any(event["kind"] == "assignment" for event in live["events"])
        proxmox.agent_exec.assert_not_called()  # No partial streamed tool can run.
        if cancel_run:
            assert client.post(f"/api/queue/{job['id']}/cancel").status_code == 200
        release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = client.get(f"/api/queue/{job['id']}").get_json()
            if state["status"] in {"completed", "cancelled", "error"}:
                break
            time.sleep(0.01)
        assert state["status"] == ("cancelled" if cancel_run else "completed")
        final = client.get(job["liveTranscriptUrl"]).get_json()
        assert final["events"]
        if cancel_run:
            proxmox.agent_exec.assert_not_called()
        else:
            proxmox.agent_exec.assert_called_once()
            assert any(event["kind"] == "tool_result" for event in final["events"])
            assert any(event["kind"] == "rubric" for event in final["events"])
            result = client.get(f"/api/queue/{job['id']}/result").get_json()
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
                events = json.loads(archive.read("student-one-101_student_one/events.json"))
                assert any(event["kind"] == "reasoning" for event in events)
        assert all(request["stream"] is True for request in requests_seen)
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("limit", [1, 2, 5])
def test_project_agent_parallel_limit_is_enforced_with_separate_archives(harness, monkeypatch, limit):
    import threading
    import time
    from flask import current_app, session

    client, body, entries, _ = harness
    entries[:] = [
        {"index": index, "name": f"guest-{index}", "vmid": 100 + index, "node": "node1", "type": "qemu"}
        for index in range(1, 7)
    ]
    body["targets"] = [{"index": entry["index"], "name": entry["name"]} for entry in entries]
    resolve = api._guest_transfer_context

    def context(*args, **kwargs):
        resolved = resolve(*args, **kwargs)
        resolved[0].agent_max_parallel_agents = limit
        return resolved

    monkeypatch.setattr(api, "_guest_transfer_context", context)
    lock = threading.Lock()
    saturated = threading.Event()
    counts = {"active": 0, "peak": 0}

    def pull(pid):
        assert session["user"] == "qa-owner"
        name = request.get_json()["targets"][0]["name"]
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr(f"{name}/home/student/evidence.txt", name)
        return jsonify(outputs_zip={"base64": base64.b64encode(output.getvalue()).decode()}, pulled=[name])

    monkeypatch.setattr(api, "instances_lxc_pull", pull)

    def run(cfg, prompt, assignment, entry, uploads, tools, cancelled, progress, secrets, emit):
        assert current_app.config["TESTING"]
        assert session["user"] == "qa-owner"
        with lock:
            counts["active"] += 1
            counts["peak"] = max(counts["peak"], counts["active"])
            if counts["active"] == limit:
                saturated.set()
        try:
            assert saturated.wait(2), "Expected agents never ran concurrently"
            time.sleep(0.02)
            tools("pull_files", {"paths": ["/home/student/evidence.txt"]})
            emit(
                {
                    "kind": "response",
                    "guest": entry["name"],
                    "index": entry["index"],
                    "type": entry["type"],
                    "text": entry["name"],
                }
            )
            return {"status": "completed", "rubric": rubric(), "score": 10, "max_score": 10}
        finally:
            with lock:
                counts["active"] -= 1

    monkeypatch.setattr(agent, "run_guest", run)
    with client.session_transaction() as accepted:
        accepted["user"] = "qa-owner"
    response = client.post("/api/projects/p/instances/actions/agent", json=body)
    assert response.status_code == 200
    result = response.get_json()
    assert counts["peak"] == limit
    assert [item["name"] for item in result["reports"]] == [entry["name"] for entry in entries]
    assert all(item["status"] == "completed" for item in result["reports"])
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        for entry in entries:
            prefix = next(
                name.rsplit("/report.json", 1)[0]
                for name in archive.namelist()
                if name.startswith(entry["name"] + "-") and name.endswith("/report.json")
            )
            assert archive.read(f"{prefix}/pulled/01/home/student/evidence.txt").decode() == entry["name"]
            events = json.loads(archive.read(f"{prefix}/events.json"))
            assert all(event["guest"] == entry["name"] for event in events)


def test_parallel_guest_failure_keeps_other_guest_reports(harness, monkeypatch):
    client, body, entries, _ = harness
    body["targets"] = [{"index": entry["index"], "name": entry["name"]} for entry in entries]
    resolve = api._guest_transfer_context

    def context(*args, **kwargs):
        resolved = resolve(*args, **kwargs)
        resolved[0].agent_max_parallel_agents = 2
        return resolved

    monkeypatch.setattr(api, "_guest_transfer_context", context)

    def run(cfg, prompt, assignment, entry, *args, **kwargs):
        if entry["index"] == 1:
            raise RuntimeError("private provider failure")
        return {"status": "completed", "rubric": rubric(), "score": 10, "max_score": 10}

    monkeypatch.setattr(agent, "run_guest", run)
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert [item["status"] for item in result["reports"]] == ["error", "completed"]
    assert result["agent_failed"] is True
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        assert len([name for name in archive.namelist() if name.endswith("/report.json")]) == 2
        assert len([name for name in archive.namelist() if name.endswith("/events.json")]) == 2


def test_parallel_cancellation_prevents_waiting_guests_from_starting(harness, monkeypatch):
    import threading

    client, body, entries, _ = harness
    entries[:] = [
        {"index": index, "name": f"guest-{index}", "vmid": 100 + index, "node": "node1", "type": "qemu"}
        for index in range(1, 7)
    ]
    body["targets"] = [{"index": entry["index"], "name": entry["name"]} for entry in entries]
    resolve = api._guest_transfer_context
    cancel = threading.Event()
    both_running = threading.Barrier(2)
    started = []

    def context(*args, **kwargs):
        resolved = resolve(*args, **kwargs)
        resolved[0].agent_max_parallel_agents = 2
        return resolved

    @client.application.before_request
    def cancellation_callback():
        g.action_queue_cancelled = cancel.is_set

    def run(cfg, prompt, assignment, entry, *args, **kwargs):
        started.append(entry["index"])
        both_running.wait(timeout=2)
        cancel.set()
        return {"status": "cancelled", "rubric": None}

    monkeypatch.setattr(api, "_guest_transfer_context", context)
    monkeypatch.setattr(agent, "run_guest", run)
    result = client.post("/api/projects/p/instances/actions/agent", json=body).get_json()
    assert sorted(started) == [1, 2]
    assert result["cancelled"] is True
    assert len(result["reports"]) == 6
    assert all(item["status"] == "cancelled" for item in result["reports"])
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["outputs_zip"]["base64"]))) as archive:
        assert len([name for name in archive.namelist() if name.endswith("/report.json")]) == 6


def test_standalone_html_escapes_endpoint_text_and_links_extracted_files():
    from html.parser import HTMLParser

    malicious = '<img src=x onerror="alert(1)"><script>bad()</script>'
    report = {
        "name": malicious,
        "vmid": 101,
        "status": "completed",
        "score": 10,
        "max_score": 10,
        "rubric": {"summary": malicious, "criteria": [{**rubric()["criteria"][0], "evidence": malicious}]},
    }
    path = "guest/pulled/01/home/student/<test>.txt"
    page = agent.report_html([report], ["guest/report.json", path])
    tags, links, displayed = [], [], []

    class Parser(HTMLParser):
        def handle_starttag(self, tag, attrs):
            tags.append(tag)
            if tag == "a":
                links.append(dict(attrs)["href"])

        def handle_data(self, data):
            displayed.append(data)

    Parser().feed(page)
    assert "script" not in tags and "img" not in tags
    assert malicious in "".join(displayed)
    assert "./guest/report.json" in links
    assert "./guest/pulled/01/home/student/%3Ctest%3E.txt" in links


@pytest.mark.parametrize(
    "context_window, max_tokens", [(32768, 16384), (65536, 32768), (65536, 40000), (131072, 65536), (1048576, 262144)]
)
def test_large_response_limit_is_sent_to_endpoint_for_selected_context(
    harness, monkeypatch, context_window, max_tokens
):
    client, body, _, proxmox = harness
    body["llm"].update(context_window=context_window, max_tokens=max_tokens)
    calls = fake_llm(
        monkeypatch,
        completion("run_command", {"command": "test -f /home/student/x.py"}),
        completion("submit_rubric", rubric()),
    )
    proxmox.agent_exec.return_value = {"exitcode": 0, "stdout": "present", "stderr": ""}
    response = client.post("/api/projects/p/instances/actions/agent", json=body)
    assert response.status_code == 200
    assert response.get_json()["reports"][0]["status"] == "completed"
    assert all(call["max_tokens"] == max_tokens for call in calls)


@pytest.mark.parametrize("max_tokens", [-1, 255, 63936, 65536, 32768.5, True])
def test_response_limits_still_require_whole_tokens_and_context_space(max_tokens):
    with pytest.raises(ValueError):
        agent.configuration({"url": "http://llm", "model": "test", "context_window": 65536, "max_tokens": max_tokens})


@pytest.mark.parametrize(
    "metadata, context, output, runtime",
    [
        ({"max_model_len": 1048576}, 1048576, None, True),
        ({"meta": {"n_ctx": 32768, "n_ctx_train": 262144}}, 32768, None, True),
        (
            {"context_length": 200000, "top_provider": {"context_length": 128000, "max_completion_tokens": 32000}},
            128000,
            32000,
            False,
        ),
        ({"context_window": "262144", "max_output_tokens": 65536}, 262144, 65536, False),
        ({"model_info": {"context_length": 32768}}, 32768, None, False),
        ({"max_context_length": 262144}, None, None, None),
        ({"context_length": -1, "max_output_tokens": True}, None, None, None),
        ({"max_model_len": float("inf"), "context_length": "unknown"}, None, None, None),
    ],
)
def test_reported_token_limit_schemas(metadata, context, output, runtime):
    limits = agent.catalog_limits(metadata)
    assert limits.get("context_window") == context
    assert limits.get("max_output_tokens") == output
    assert limits.get("runtime") == runtime


def discovery_stub(monkeypatch, catalog, **native):
    calls = []

    def invoke(cfg, resource, payload=None, **kwargs):
        calls.append((cfg.copy(), resource, payload))
        if resource == "/models":
            return {"data": catalog}
        if resource in native:
            return native[resource]
        raise ValueError("LLM endpoint returned HTTP 404")

    monkeypatch.setattr(agent, "llm_request", invoke)
    return calls


def test_lm_studio_uses_loaded_context_and_conservative_alias_limit(monkeypatch):
    discovery_stub(
        monkeypatch,
        [{"id": "model"}, {"id": "instance-one"}, {"id": "instance-two"}, {"id": "unloaded"}],
        **{
            "/api/v1/models": {
                "models": [
                    {
                        "type": "llm",
                        "key": "model",
                        "max_context_length": 262144,
                        "loaded_instances": [
                            {"id": "instance-one", "config": {"context_length": 32768}},
                            {"id": "instance-two", "config": {"context_length": 65536}},
                        ],
                    },
                    {"type": "llm", "key": "unloaded", "max_context_length": 1048576, "loaded_instances": []},
                ]
            }
        },
    )
    cfg = agent.configuration({"url": "http://llm/v1", "model": "model"})
    _, limits = agent.discover_models(cfg)
    assert limits["model"]["context_window"] == 32768
    assert limits["model"]["model_context_window"] == 262144
    assert limits["instance-two"]["context_window"] == 65536
    assert limits["unloaded"] == {"model_context_window": 1048576}


def test_native_probe_uses_same_gateway_auth_and_never_autoloads(app, monkeypatch):
    paths = []

    def invoke(method, url, **kwargs):
        paths.append((method, url, kwargs))
        response = MagicMock(status_code=200)
        if url.endswith("/v1/models"):
            response.json.return_value = {"data": [{"id": "a/b"}, {"id": "other"}]}
        elif "/props?" in url:
            response.json.return_value = {"model_alias": "a/b", "default_generation_settings": {"n_ctx": 65536}}
        else:
            response.status_code = 404
        return response

    monkeypatch.setattr(agent.requests, "request", invoke)
    response = app.test_client().post(
        "/api/plugins/agent/models",
        json={
            "url": "https://llm/gateway/v1",
            "model": "a/b",
            "api_key": "secret",
            "ssl_verify": False,
            # Fetch only needs connection fields, regardless of an invalid form budget.
            "context_window": -5,
            "max_tokens": 1000000,
        },
    )
    assert response.status_code == 200
    limits = response.get_json()["model_limits"]
    assert limits["a/b"]["context_window"] == 65536
    assert limits["other"] == {}
    assert paths[-1][1] == "https://llm/gateway/props?model=a%2Fb&autoload=false"
    for method, url, kwargs in paths:
        assert method == "GET"
        assert url.startswith("https://llm/gateway/")
        assert kwargs["headers"]["Authorization"] == "Bearer secret"
        assert kwargs["verify"] is False
        assert kwargs["allow_redirects"] is False
    assert paths[-1][2]["timeout"] == (3, 3)


def test_ollama_runtime_context_is_scoped_to_loaded_model(monkeypatch):
    discovery_stub(
        monkeypatch,
        [{"id": "a"}, {"id": "b"}],
        **{"/api/ps": {"models": [{"name": "a", "model": "a", "context_length": 262144}]}},
    )
    _, limits = agent.discover_models(agent.configuration({"url": "http://llm/v1", "model": "a"}))
    assert limits["a"]["context_window"] == 262144
    assert limits["a"]["runtime"]
    assert limits["b"] == {}


def test_provider_max_is_refreshed_for_run_and_in_transcript(harness, monkeypatch):
    client, body, _, _ = harness
    body["llm"].update(context_auto=True, context_window=16384, max_tokens=262144)
    seen = []

    def invoke(cfg, resource, payload=None, **kwargs):
        seen.append(resource)
        if resource == "/models":
            return {"data": [{"id": "test", "max_model_len": 1048576}]}
        assert cfg["context_window"] == 1048576
        assert payload["max_tokens"] == 262144
        return completion("submit_rubric", rubric("unknown"))

    monkeypatch.setattr(agent, "llm_request", invoke)
    response = client.post("/api/projects/p/instances/actions/agent", json=body)
    assert response.status_code == 200
    assert seen == ["/models", "/chat/completions"]
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(response.get_json()["outputs_zip"]["base64"]))) as archive:
        events = json.loads(archive.read("student-one-101_student_one/events.json"))
        turn = next(event for event in events if event["kind"] == "turn_start")
        assert turn["data"]["context_window"] == 1048576
        assert turn["data"]["max_tokens"] == 262144
        assert turn["data"]["provider_limits"]["runtime"] is True


@pytest.mark.parametrize(
    "settings, limits, error",
    [
        ({"context_window": 1048576}, {"context_window": 32768}, "Context window exceeds"),
        (
            {"context_window": 65536, "max_tokens": 32768},
            {"context_window": 65536, "max_output_tokens": 16384},
            "Max response tokens exceeds",
        ),
        ({"context_auto": True}, {}, "did not report a usable context"),
        ({"context_auto": True, "max_tokens": 32768}, {"context_window": 32768}, "for this context window"),
    ],
)
def test_refreshed_provider_limits_fail_before_guest_resolution(harness, monkeypatch, settings, limits, error):
    client, body, _, _ = harness
    body["llm"].update(discover_limits=True, **settings)
    monkeypatch.setattr(agent, "discover_models", lambda cfg: (["test"], {"test": limits}))
    resolve = MagicMock()
    monkeypatch.setattr(api, "_guest_transfer_context", resolve)
    response = client.post("/api/projects/p/instances/actions/agent", json=body)
    assert response.status_code == 400
    assert error in response.get_json()["error"]
    resolve.assert_not_called()


def test_manual_context_still_runs_when_discovery_unavailable(harness, monkeypatch):
    client, body, _, _ = harness
    body["llm"].update(discover_limits=True, context_window=1048576, max_tokens=262144)
    monkeypatch.setattr(agent, "discover_models", MagicMock(side_effect=ValueError("No model catalog")))
    calls = fake_llm(monkeypatch, completion("submit_rubric", rubric("unknown")))
    response = client.post("/api/projects/p/instances/actions/agent", json=body)
    assert response.status_code == 200
    assert calls[0]["max_tokens"] == 262144
