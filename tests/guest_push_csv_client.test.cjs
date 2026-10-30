const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('app/static/js/guest_push_csv.js', 'utf8'), sandbox);
const csv = sandbox.GuestPushCsv;
const plain = value => JSON.parse(JSON.stringify(value));

test('CSV accepts optional usernames, headers, BOM, blank lines, and ignores columns after username', () => {
  const expected = [{ vmid: 101, sourcePath: '/srv/a', destinationPath: '/opt/one', username: 'alice' }, { vmid: 102, sourcePath: '/srv/b', destinationPath: '/etc/two', username: 'bob' }];
  assert.deepEqual(plain(csv.parse('\uFEFFVMID,source,destination,username,notes\r\n\r\n101,/srv/a,/opt/one,alice,ignored\r\n102,/srv/b,/etc/two,bob,x,y\r\n')), expected);
  assert.deepEqual(plain(csv.parse('101,/srv/a,/opt/one\n102,/srv/b,/etc/two,')), expected.map(row => ({ ...row, username: '' })));
});

test('CSV preserves quoted commas, escaped quotes, spaces, and multiline paths', () => {
  assert.deepEqual(plain(csv.parse('101,"/srv/a,b","/opt/renamed ""file""","a,b"\n102,"/srv/a\nb",/etc/two')),
    [{ vmid: 101, sourcePath: '/srv/a,b', destinationPath: '/opt/renamed "file"', username: 'a,b' }, { vmid: 102, sourcePath: '/srv/a\nb', destinationPath: '/etc/two', username: '' }]);
});

const previewGroups = [{ pid: 'p', projectName: 'Exam', targets: [
  { index: 1, vmid: 101, name: 'guest-one', username: 'alice', node: 'node1', type: 'qemu', password: 'never-display' },
  { index: 2, vmid: 102, name: 'guest-two', username: 'bob', node: 'node2', type: 'lxc' },
] }];

test('preview shows assigned and optional CSV usernames, context, line numbers, and duplicate rows', () => {
  const result = csv.preview('vmid,source,dest,username\n\n101,"/a\nb",/dest,alice\n102,/b,/two,wrong\n102,/b,/two\n', previewGroups);
  assert.deepEqual(plain(result.rows.map(row => [row.rowNumber, row.vmid, row.assignedUsername, row.username, row.usernameMismatch, row.duplicate])),
    [[3, 101, 'alice', 'alice', false, false], [5, 102, 'bob', 'wrong', true, false], [6, 102, 'bob', '', false, true]]);
  assert.equal(result.transferCount, 2);
  assert.equal(result.guestCount, 2);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(result.rows[0].projectName, 'Exam');
  assert.equal(result.rows[0].node, 'node1');
  assert.equal(result.rows[0].guestName, 'guest-one');
  assert.ok(!JSON.stringify(result).includes('never-display'));
});

test('preview retains invalid and unmatched rows for review and identifies conflicting destinations', () => {
  const result = csv.preview('101,/a,/dest\n999,/b,/two\ninvalid,/c,/three\n101,relative,/four\n101,/different,/dest', previewGroups);
  assert.equal(result.rows.length, 5);
  assert.equal(result.errorCount, 4);
  assert.match(result.rows[1].error, /not among the selected/);
  assert.equal(result.rows[1].assignedUsername, '');
  assert.match(result.rows[2].error, /positive integer/);
  assert.match(result.rows[3].error, /absolute file path/);
  assert.equal(result.rows[3].assignedUsername, 'alice', 'path errors retain a known VMID/username match');
  assert.match(result.rows[4].error, /Multiple source files/);
  const ambiguous = csv.preview('101,/a,/b', [...previewGroups, { pid: 'q', targets: previewGroups[0].targets }]);
  assert.match(ambiguous.rows[0].error, /multiple selected guests/);
  assert.equal(ambiguous.rows[0].assignedUsername, '');
});

test('optional username differences never change transfers or leak preview metadata to executable targets', () => {
  const result = csv.plan(csv.parse('101,/a,/b,wrong,ignored'), previewGroups);
  assert.deepEqual(plain(result.transfers), [{ pid: 'p', vmid: 101, sourcePath: '/a', destinationPath: '/b' }]);
  assert.deepEqual(plain(result.groups[0].targets), [{ index: 1, vmid: 101, name: 'guest-one', type: 'qemu' }]);
});

test('preview renders CSV values as literal text and highlights username differences and row errors', () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.ownerDocument = document; }
    set innerHTML(value) { assert.fail('CSV values must never be rendered as HTML'); }
    append(child) { this.children.push(child); }
    replaceChildren(fragment) { this.children = fragment.children; }
  }
  const document = { createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment') };
  const body = new Element('tbody');
  const result = csv.preview('101,/src/<script>,/dest,"<img onerror=bad>"\n999,/a,/b', previewGroups);
  csv.renderPreview(body, result);
  assert.equal(body.children[0].className, 'table-warning');
  assert.equal(body.children[0].children[2].textContent, 'alice');
  assert.equal(body.children[0].children[3].textContent, '<img onerror=bad>');
  assert.equal(body.children[0].children[4].textContent, '/src/<script>');
  assert.equal(body.children[0].children[6].textContent, 'Username differs');
  assert.equal(body.children[1].className, 'table-danger');
  assert.equal(body.children[1].children[2].textContent, 'Unassigned');
});

test('CSV rejects empty manifests, invalid IDs, invalid file paths, and malformed quotes', () => {
  for (const text of ['', 'vmid,source,destination', 'no,/a,/b', '0,/a,/b', '-1,/a,/b', '1.5,/a,/b', '101', '101,/a', '101,/a,relative', '101,relative,/b', '101,/a/,/b', '101,/a,/b/../', '101,/a/../b,/c', '101,"unclosed', '101,"/a"oops,/b']) {
    assert.throws(() => csv.parse(text), text);
  }
});

test('directory destinations preserve source filenames in both preview and execution', () => {
  for (const directory of ['/memory-hw-graded/', '/']) {
    const text = `101,/srv/feedback.zip,${directory},alice`;
    const expected = `${directory}feedback.zip`;
    const result = csv.preview(text, previewGroups);
    assert.equal(result.errorCount, 0);
    assert.equal(result.rows[0].destinationPath, expected);
    assert.equal(result.rows[0].csvDestinationPath, directory);
    assert.equal(csv.plan(csv.parse(text), previewGroups).transfers[0].destinationPath, expected);
  }
  assert.throws(() => csv.plan(csv.parse('101,/srv/feedback.zip,/dir/\n101,/other.zip,/dir/feedback.zip'), previewGroups), /multiple source files/);
});

const groups = [{ pid: 'p', targets: [101, 102, 103].map((vmid, index) => ({ vmid, index, name: `vm-${vmid}`, type: 'qemu' })) }];

test('CSV plans only listed guests, preserves distinct destination paths, and deduplicates rows', () => {
  const result = csv.plan(csv.parse('101,/a,/one\n102,/b,/two\n102,/a,/three\n101,/a,/one'), groups);
  assert.deepEqual(plain(result.groups[0].targets.map(target => target.vmid)), [101, 102]);
  assert.deepEqual(plain(result.transfers), [
    { pid: 'p', vmid: 101, sourcePath: '/a', destinationPath: '/one' },
    { pid: 'p', vmid: 102, sourcePath: '/b', destinationPath: '/two' },
    { pid: 'p', vmid: 102, sourcePath: '/a', destinationPath: '/three' },
  ]);
});

test('CSV refuses unknown or ambiguous guests and conflicting destination paths', () => {
  assert.throws(() => csv.plan(csv.parse('999,/a,/b'), groups), /not among the selected/);
  assert.throws(() => csv.plan(csv.parse('101,/a,/b'), [...groups, { pid: 'other', targets: groups[0].targets }]), /multiple selected guests/);
  assert.throws(() => csv.plan(csv.parse('101,/a,/dest\n101,/b,/dest'), groups), /multiple source files/);
  assert.throws(() => csv.plan(csv.parse('101,/a,/opt//dest\n101,/b,/opt/dest'), groups), /multiple source files/);
});
