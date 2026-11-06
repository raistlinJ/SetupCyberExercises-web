import json
from unittest.mock import MagicMock

import pytest

from app import agent_plugin as agent
from app import openai_responses


def config(**fields):
    return agent.configuration({'url': 'https://api.openai.com/v1', 'model': 'gpt-6.1-sol',
                                'api_key': 'test-private-key', **fields})


def function_call(name='run_command', args=None, call_id='call_1'):
    return {'type': 'function_call', 'id': 'fc_' + call_id, 'call_id': call_id,
            'name': name, 'arguments': json.dumps(args or {'command': 'hostname'}), 'status': 'completed'}


def completed(*output):
    return {'id': 'resp_1', 'status': 'completed', 'output': list(output), 'usage': {'output_tokens': 20}}


def json_response(data, status=200):
    response = MagicMock(status_code=status)
    response.headers = {'Content-Type': 'application/json'}
    response.json.return_value = data
    return response


def stream_response(*events):
    response = MagicMock(status_code=200)
    response.headers = {'Content-Type': 'text/event-stream'}
    response.iter_lines.return_value = iter(line for event in events for line in (
        b'event: ' + event['type'].encode(), b'data: ' + json.dumps(event).encode(), b'',
    ))
    return response


def chat_payload(**fields):
    return {'model': 'gpt-6.1-sol', 'messages': [{'role': 'system', 'content': 'Inspect the selected guest'},
            {'role': 'user', 'content': 'Check hostname'}], 'tools': agent.TOOLS, 'tool_choice': 'auto',
            'max_tokens': 120000, 'stream': True, **fields}


def test_official_openai_uses_responses_schema_and_keeps_auth_and_streaming(monkeypatch):
    request = MagicMock(return_value=json_response(completed(function_call())))
    monkeypatch.setattr(agent.requests, 'request', request)
    payload = chat_payload(temperature=0.2)
    result = agent.llm_request(config(), '/chat/completions', payload)
    assert request.call_args.args == ('POST', 'https://api.openai.com/v1/responses')
    options = request.call_args.kwargs
    assert options['headers']['Authorization'] == 'Bearer test-private-key'
    assert options['allow_redirects'] is False
    assert options['stream'] is True
    assert options['json']['max_output_tokens'] == 120000
    assert 'max_tokens' not in options['json'] and 'temperature' not in options['json']
    assert options['json']['input'] == payload['messages']
    assert options['json']['store'] is False
    assert options['json']['include'] == ['reasoning.encrypted_content']
    assert options['json']['tools'][0]['type'] == 'function'
    assert options['json']['tools'][0]['name'] == agent.TOOLS[0]['function']['name']
    assert options['json']['tools'][0]['strict'] is False
    assert result['choices'][0]['message']['tool_calls'][0]['id'] == 'call_1'
    assert payload['max_tokens'] == 120000, 'Conversion must not mutate the original request'


def test_forced_tool_and_reasoning_history_are_replayed_in_responses_format():
    reasoning = {'type': 'reasoning', 'id': 'rs_1', 'summary': [], 'encrypted_content': 'opaque-reasoning'}
    call = function_call()
    assistant = openai_responses.chat_result(completed(reasoning, call))['choices'][0]['message']
    payload = chat_payload(tool_choice={'type': 'function', 'function': {'name': 'submit_rubric'}})
    payload['messages'] += [assistant, {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'guest hostname'}]
    result = openai_responses.request_payload(payload)
    assert result['input'][2:4] == [reasoning, call]
    assert result['input'][4] == {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'guest hostname'}
    assert result['tool_choice'] == {'type': 'function', 'name': 'submit_rubric'}


def test_assistant_text_phase_and_reasoning_remain_in_replayable_output():
    output = [
        {'type': 'reasoning', 'id': 'rs_1', 'summary': [{'type': 'summary_text', 'text': 'Check the host'}],
         'encrypted_content': 'opaque-reasoning'},
        {'type': 'message', 'role': 'assistant', 'phase': 'commentary', 'status': 'completed',
         'content': [{'type': 'output_text', 'text': 'Checking hostname.', 'annotations': []}]},
        function_call(),
    ]
    message = openai_responses.chat_result(completed(*output))['choices'][0]['message']
    assert message['content'] == 'Checking hostname.'
    assert message['reasoning_content'] == 'Check the host'
    assert message['responses_output'] == output


def test_stream_displays_deltas_but_returns_only_completed_tools(monkeypatch):
    call = function_call()
    response = stream_response(
        {'type': 'response.reasoning_summary_text.delta', 'delta': 'Inspect hostname.'},
        {'type': 'response.output_text.delta', 'delta': 'Checking.'},
        {'type': 'response.output_item.added', 'output_index': 1, 'item': {**call, 'arguments': ''}},
        {'type': 'response.function_call_arguments.delta', 'output_index': 1, 'delta': '{"command":"host'},
        {'type': 'response.function_call_arguments.delta', 'output_index': 1, 'delta': 'name"}'},
        {'type': 'response.completed', 'response': completed(call)},
    )
    monkeypatch.setattr(agent.requests, 'request', MagicMock(return_value=response))
    callback = MagicMock()
    result = agent.llm_request(config(), '/chat/completions', chat_payload(), on_delta=callback)
    assert result['choices'][0]['message']['tool_calls'][0]['function']['arguments'] == call['arguments']
    assert [call.args[0] for call in callback.call_args_list] == [
        'reasoning', 'response', 'tool_name', 'tool_arguments', 'tool_arguments', 'usage',
    ]
    assert response.iter_lines.call_args.kwargs['chunk_size'] == 1


@pytest.mark.parametrize('mode', ['per_guest', 'collective'])
def test_both_agent_modes_replay_reasoning_and_tool_results_before_final_submission(monkeypatch, mode):
    reasoning = {'type': 'reasoning', 'id': 'rs_1', 'summary': [], 'encrypted_content': 'opaque-reasoning'}
    args = {'command': 'hostname'}
    if mode == 'collective':
        args['guest_id'] = 'g1'
        final = function_call('submit_result', {'summary': 'Checked hostname', 'guests': [
            {'guest_id': 'g1', 'status': 'completed', 'summary': 'Hostname inspected'},
        ]}, 'call_final')
    else:
        final = function_call('submit_rubric', {'summary': 'Checked hostname', 'criteria': [
            {'criterion': 'Hostname', 'score': 1, 'max_score': 1, 'status': 'pass', 'evidence': 'hostname', 'feedback': 'Valid'},
        ]}, 'call_final')
    first = function_call(args=args)
    request = MagicMock(side_effect=[json_response(completed(reasoning, first)), json_response(completed(final))])
    monkeypatch.setattr(agent.requests, 'request', request)
    tool = MagicMock(return_value={'stdout': 'guest-host', 'exitcode': 0})
    guest = {'name': 'guest', 'vmid': 101, 'index': 1, 'type': 'qemu', 'guest_id': 'g1', 'projectId': 'p'}
    options = {'cfg': config(), 'prompt': 'Inspect the hostname', 'assignment': '', 'uploads': {},
               'cancelled': lambda: False, 'progress': lambda event: None, 'secrets': ['test-private-key'], 'emit': lambda event: None}
    if mode == 'collective':
        result = agent.run_collective(**options, guests=[guest], guest_tools={'g1': tool})
    else:
        result = agent.run_guest(**options, entry=guest, tools=tool)
    assert result['status'] == 'completed', result
    tool.assert_called_once()
    history = request.call_args.kwargs['json']['input']
    assert history[2:4] == [reasoning, first]
    assert history[4]['type'] == 'function_call_output'
    assert history[4]['call_id'] == 'call_1'
    assert 'guest-host' in history[4]['output']


def test_incomplete_openai_stream_never_dispatches_partial_tools(monkeypatch):
    response = stream_response({'type': 'response.output_item.added', 'output_index': 0, 'item': function_call()})
    monkeypatch.setattr(agent.requests, 'request', MagicMock(return_value=response))
    tool = MagicMock()
    result = agent.run_guest(config(), 'Check hostname', '', {'name': 'guest'}, {}, tool,
                             lambda: False, lambda event: None, [])
    assert result['status'] == 'error'
    assert 'ended before' in result['error']
    tool.assert_not_called()


def test_openai_stream_cancellation_stops_before_returning_tools(monkeypatch):
    response = stream_response({'type': 'response.completed', 'response': completed(function_call())})
    monkeypatch.setattr(agent.requests, 'request', MagicMock(return_value=response))
    with pytest.raises(agent.AgentCancelled):
        agent.llm_request(config(), '/chat/completions', chat_payload(), cancelled=lambda: True)


@pytest.mark.parametrize('status', ['incomplete', 'failed'])
def test_noncompleted_responses_never_supply_executable_tools(status):
    data = {**completed(function_call()), 'status': status, 'incomplete_details': {'reason': 'max_output_tokens'}}
    with pytest.raises(ValueError, match='token limit'):
        openai_responses.chat_result(data)


@pytest.mark.parametrize('url', ['http://localhost:1234/v1', 'https://api.openai.com.example.test/v1'])
def test_compatible_endpoints_keep_chat_completions(monkeypatch, url):
    data = {'choices': [{'message': {'content': 'compatible response'}}]}
    request = MagicMock(return_value=json_response(data))
    monkeypatch.setattr(agent.requests, 'request', request)
    payload = chat_payload(temperature=0.2)
    assert agent.llm_request(config(url=url), '/chat/completions', payload) == data
    assert request.call_args.args[1] == url + '/chat/completions'
    assert request.call_args.kwargs['json'] == payload


def test_provider_error_includes_parameter_but_never_api_key(monkeypatch):
    response = json_response({'error': {'message': 'Unsupported value for test-private-key', 'param': 'temperature'}}, 400)
    request = MagicMock(return_value=response)
    monkeypatch.setattr(agent.requests, 'request', request)
    with pytest.raises(ValueError) as error:
        agent.llm_request(config(), '/chat/completions', chat_payload())
    assert 'HTTP 400: Unsupported value for [redacted]' in str(error.value)
    assert '(parameter: temperature)' in str(error.value)
    assert 'test-private-key' not in str(error.value)
    request.assert_called_once()


def test_non_json_error_retains_status_without_dumping_error_page(monkeypatch):
    response = json_response(None, 502)
    response.json.side_effect = ValueError('HTML response')
    monkeypatch.setattr(agent.requests, 'request', MagicMock(return_value=response))
    with pytest.raises(ValueError, match='^LLM endpoint returned HTTP 502$'):
        agent.llm_request(config(), '/models')
