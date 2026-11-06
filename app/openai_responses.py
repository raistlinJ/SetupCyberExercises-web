"""Translate the guest agent's tool conversation to OpenAI Responses."""
import json


def request_payload(chat):
    inputs = []
    for message in chat['messages']:
        if message.get('responses_output') is not None:
            # Reasoning items and function calls must accompany their tool results.
            inputs.extend(message['responses_output'])
        elif message['role'] == 'tool':
            inputs.append({'type': 'function_call_output', 'call_id': message['tool_call_id'],
                           'output': message['content']})
        else:
            inputs.append({'role': message['role'], 'content': message.get('content') or ''})
    result = {
        'model': chat['model'], 'input': inputs,
        'tools': [{'type': 'function', **tool['function'], 'strict': False} for tool in chat['tools']],
        'tool_choice': chat.get('tool_choice', 'auto'),
        'max_output_tokens': chat['max_tokens'], 'stream': chat.get('stream', False),
        'store': False, 'include': ['reasoning.encrypted_content'],
    }
    if isinstance(result['tool_choice'], dict):
        result['tool_choice'] = {'type': 'function', 'name': result['tool_choice']['function']['name']}
    # Reasoning models reject temperature with their default reasoning effort.
    if 'temperature' in chat and not chat['model'].startswith(('gpt-5', 'gpt-6', 'o1', 'o3', 'o4')):
        result['temperature'] = chat['temperature']
    return result


def chat_result(response):
    if not isinstance(response, dict):
        raise ValueError('LLM endpoint returned an invalid Responses object')
    if response.get('status') != 'completed':
        reason = (response.get('incomplete_details') or {}).get('reason')
        if reason == 'max_output_tokens':
            raise ValueError('LLM response reached the token limit; increase max response tokens')
        error = response.get('error') or {}
        detail = error.get('message') if isinstance(error, dict) else str(error)
        raise ValueError('LLM response did not complete' + (f': {detail}' if detail else ''))
    output = response.get('output')
    if not isinstance(output, list) or not output or not all(isinstance(item, dict) for item in output):
        raise ValueError('LLM response contains no output')
    message = {'role': 'assistant', 'content': '', 'responses_output': output}
    calls = []
    for item in output:
        if item.get('type') == 'function_call':
            calls.append({'id': item['call_id'], 'type': 'function',
                          'function': {'name': item['name'], 'arguments': item['arguments']}})
        elif item.get('type') == 'message':
            for part in item.get('content', []):
                if part.get('type') == 'output_text':
                    message['content'] += part.get('text', '')
                elif part.get('type') == 'refusal':
                    message['refusal'] = message.get('refusal', '') + part.get('refusal', '')
        elif item.get('type') == 'reasoning':
            summary = ''.join(part.get('text', '') for part in item.get('summary', []))
            if summary:
                message['reasoning_content'] = message.get('reasoning_content', '') + summary
    if calls:
        message['tool_calls'] = calls
    return {'choices': [{'message': message, 'finish_reason': 'tool_calls' if calls else 'stop'}],
            'usage': response.get('usage')}


def read_stream(response, on_delta=None, check_cancelled=None):
    """Only completed responses can supply executable tools; deltas are display-only."""
    pending = []
    tool_indexes = {}

    def emit(kind, text, details=None):
        if on_delta and text:
            on_delta(kind, text, details or {})

    def consume(raw):
        event = json.loads(raw)
        kind = event.get('type')
        if kind in ('response.completed', 'response.incomplete', 'response.failed'):
            return chat_result(event.get('response'))
        if kind == 'error':
            raise ValueError('LLM stream reported an error: ' + str(event.get('message') or 'Unknown error'))
        if kind == 'response.output_item.added' and event.get('item', {}).get('type') == 'function_call':
            index = event['output_index']
            tool_indexes[index] = len(tool_indexes)
            if len(tool_indexes) > 8:
                raise ValueError('Model must return at most eight tool calls per turn')
            emit('tool_name', event['item'].get('name', ''), {'toolCallIndex': tool_indexes[index]})
        elif kind == 'response.function_call_arguments.delta':
            index = event.get('output_index')
            if index not in tool_indexes:
                raise ValueError('Invalid streamed tool index')
            emit('tool_arguments', event.get('delta', ''), {'toolCallIndex': tool_indexes[index]})
        elif kind in ('response.output_text.delta', 'response.refusal.delta'):
            emit('response', event.get('delta', ''))
        elif kind in ('response.reasoning_summary_text.delta', 'response.reasoning_text.delta'):
            emit('reasoning', event.get('delta', ''))
        return None

    for line in response.iter_lines(chunk_size=1):
        if check_cancelled:
            check_cancelled()
        if isinstance(line, bytes):
            line = line.decode('utf-8')
        if not line:
            if pending:
                result = consume('\n'.join(pending))
                pending.clear()
                if result is not None:
                    if result.get('usage'):
                        emit('usage', json.dumps(result['usage']))
                    return result
        elif line.startswith('data:'):
            pending.append(line[5:].lstrip())
    if pending:
        result = consume('\n'.join(pending))
        if result is not None:
            return result
    raise ValueError('LLM stream ended before the response completed')
