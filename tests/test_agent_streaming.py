import json
from unittest.mock import MagicMock

import pytest

from app import agent_plugin as agent


def stream(*chunks, done=True):
    response = MagicMock(status_code=200)
    response.headers = {'Content-Type': 'text/event-stream'}
    lines = []
    for chunk in chunks:
        lines += [b'data: ' + json.dumps(chunk).encode(), b'']
    if done:
        lines += [b'data: [DONE]', b'']
    response.iter_lines.return_value = iter(lines)
    return response


def delta(value, finish=None):
    return {'choices': [{'index': 0, 'delta': value, 'finish_reason': finish}]}


def test_stream_assembles_reasoning_content_and_partial_tool_arguments():
    callback = MagicMock()
    response = stream(delta({'reasoning_content': 'Check the '}), delta({'reasoning_content': 'required paths.'}),
                      delta({'content': 'I will verify files.'}),
                      delta({'tool_calls': [{'index': 0, 'id': 'call1', 'type': 'function', 'function': {'name': 'run_command', 'arguments': '{"command":'}}]}),
                      delta({'tool_calls': [{'index': 0, 'function': {'arguments': '"hostname"}'}}]}, 'tool_calls'))
    result = agent.read_chat_stream(response, callback)
    message = result['choices'][0]['message']
    assert message['reasoning_content'] == 'Check the required paths.'
    assert message['content'] == 'I will verify files.'
    assert message['tool_calls'][0]['function']['arguments'] == '{"command":"hostname"}'
    assert any(call.args[0] == 'reasoning' for call in callback.call_args_list)
    assert any(call.args[0] == 'tool_arguments' for call in callback.call_args_list)
    assert response.iter_lines.call_args.kwargs['chunk_size'] == 1


def test_truncated_stream_never_returns_executable_partial_tool():
    response = stream(delta({'tool_calls': [{'index': 0, 'id': 'call1', 'function': {'name': 'run_command', 'arguments': '{"command":"rm'}}]}), done=False)
    with pytest.raises(ValueError, match='ended before'):
        agent.read_chat_stream(response)


def test_stream_can_be_cancelled_before_next_tool():
    with pytest.raises(agent.AgentCancelled):
        agent.read_chat_stream(stream(delta({'content': 'Starting'})), cancelled=lambda: True)


def test_live_output_redacts_secrets_split_across_delta_chunks():
    events = []
    live = agent.LiveModelOutput(lambda kind, text, **details: events.append({'kind': kind, 'text': text}), ['long-api-secret', 'password'])
    for text in ['Visible ', 'long-api-', 'secret and ', 'pass', 'word output.']:
        live.last = 0
        live.feed('reasoning', text)
    live.flush(final=True)
    result = ''.join(event['text'] for event in events)
    assert result == 'Visible [redacted] and [redacted] output.'


def test_live_output_redacts_json_escaped_secrets_across_chunks():
    secret = 'quoted"\\secret\né'
    events = []
    live = agent.LiveModelOutput(lambda kind, text, **details: events.append(text), [secret])
    escaped = json.dumps(secret)[1:-1]
    for character in 'Arguments: ' + escaped + ' done':
        live.last = 0
        live.feed('tool_arguments', character, {'toolCallIndex': 0})
    live.flush(final=True)
    assert ''.join(events) == 'Arguments: [redacted] done'


def test_live_output_emits_first_token_without_waiting_for_secret_length():
    events = []
    live = agent.LiveModelOutput(lambda kind, text, **details: events.append(text), ['long-private-api-key'])
    live.feed('response', 'Hello!')
    assert events == ['Hello!']


def test_transport_enables_sse_without_following_redirects(monkeypatch):
    cfg = agent.configuration({'url': 'http://llm/v1', 'model': 'test'})
    response = stream(delta({'content': 'Hello'}, 'stop'))
    request = MagicMock(return_value=response)
    monkeypatch.setattr(agent.requests, 'request', request)
    result = agent.llm_request(cfg, '/chat/completions', {'stream': True})
    assert result['choices'][0]['message']['content'] == 'Hello'
    assert request.call_args.kwargs['stream'] is True
    assert request.call_args.kwargs['headers']['Accept'] == 'text/event-stream'
    assert request.call_args.kwargs['allow_redirects'] is False


def test_nonstreaming_compatible_response_is_still_supported(monkeypatch):
    cfg = agent.configuration({'url': 'http://llm/v1', 'model': 'test'})
    response = MagicMock(status_code=200)
    response.headers = {'Content-Type': 'application/json'}
    response.json.return_value = {'choices': [{'message': {'content': 'Hello'}}]}
    monkeypatch.setattr(agent.requests, 'request', MagicMock(return_value=response))
    assert agent.llm_request(cfg, '/chat/completions', {'stream': True}) == response.json.return_value


def test_stream_preserves_structured_provider_reasoning():
    details = [{'type': 'reasoning.text', 'text': 'Verify the file.'}]
    result = agent.read_chat_stream(stream(delta({'reasoning_details': details, 'content': 'Result'}, 'stop')))
    assert result['choices'][0]['message']['reasoning_details'] == details


def test_invalid_tool_index_is_rejected():
    with pytest.raises(ValueError, match='tool index'):
        agent.read_chat_stream(stream(delta({'tool_calls': [{'index': 100}]})))
