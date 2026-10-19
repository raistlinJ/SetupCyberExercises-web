const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const window = {};
vm.runInNewContext(fs.readFileSync('app/static/js/ctfrpg_table.js', 'utf8'), {window});
const {buildRows, filterRows, sortRows} = window.CTFRPG_Table;

function rows() {
  return buildRows([
    {id: 'one', name: 'Quest', credentials: [{username: 'alice'}, {username: 'bob'}, {username: 'carol'}]},
  ], new Set(['one']), [{id: 'one', users: [
    {username: 'alice', exists: true, team: 'Blue', score: 25, rank: 2, completed: 1},
    {username: 'bob', exists: true, team: 'Red', score: 50, rank: 1, completed: 2},
    {username: 'carol', exists: false},
  ]}], [{id: 'one', teams: [
    {username: 'Blue', score: 75, rank: 2}, {username: 'Red', score: 100, rank: 1},
  ]}]);
}

test('team rank and points join each credential row without adding team rows', () => {
  const result = rows();
  assert.equal(result.length, 3);
  assert.equal(result[0].teamName, 'Blue');
  assert.equal(result[0].teamPoints, 75);
  assert.equal(result[0].teamRank, 2);
  assert.equal(result[2].teamPoints, null);
});

test('name and rank sorting match CTFd and keep missing values last', () => {
  const result = rows();
  assert.deepEqual(Array.from(sortRows(result, {key: 'user', dir: 'asc'}), row => row.username), ['alice', 'bob', 'carol']);
  assert.deepEqual(Array.from(sortRows(result, {key: 'user', dir: 'asc'}, 'rank'), row => row.username), ['bob', 'alice', 'carol']);
  assert.deepEqual(Array.from(sortRows(result, {key: 'team_points', dir: 'desc'}), row => row.username), ['bob', 'alice', 'carol']);
  assert.deepEqual(Array.from(sortRows(result, {key: 'team', dir: 'asc'}, 'name', 'rank'), row => row.username), ['bob', 'alice', 'carol']);
  assert.deepEqual(Array.from(sortRows(result, {key: 'team', dir: 'desc'}, 'name', 'rank'), row => row.username), ['alice', 'bob', 'carol']);
});

test('filter includes team metrics and regex errors leave the rows visible', () => {
  assert.deepEqual(Array.from(filterRows(rows(), '100').rows, row => row.username), ['bob']);
  assert.deepEqual(Array.from(filterRows(rows(), '^bl', true).rows, row => row.username), ['alice']);
  const invalid = filterRows(rows(), '[', true);
  assert.equal(invalid.error, true);
  assert.equal(invalid.rows.length, 3);
});

test('same username and team in different projects retain their own scores', () => {
  const result = buildRows([
    {id: 'one', name: 'First', credentials: [{username: 'alice'}]},
    {id: 'two', name: 'Second', credentials: [{username: 'alice'}]},
  ], new Set(['one', 'two']), [
    {id: 'one', users: [{username: 'alice', exists: true, team: 'Blue', score: 10, rank: 2}]},
    {id: 'two', users: [{username: 'alice', exists: true, team: 'Blue', score: 90, rank: 1}]},
  ], [
    {id: 'one', teams: [{username: 'Blue', score: 20, rank: 2}]},
    {id: 'two', teams: [{username: 'Blue', score: 120, rank: 1}]},
  ]);
  assert.deepEqual(Array.from(sortRows(result, {key: 'team_points', dir: 'desc'}), row => [row.project.id, row.teamPoints]), [
    ['two', 120], ['one', 20],
  ]);
});
