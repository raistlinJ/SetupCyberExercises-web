(() => {
  'use strict';

  const text = value => String(value ?? '').trim();
  const number = value => value === null || value === undefined || text(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const rank = value => {
    const result = number(value);
    return result !== null && result > 0 ? result : null;
  };

  function buildRows(projects, selectedProjects, results, teamResults, errors = {}) {
    const usersByProject = new Map((results || []).map(item => [String(item.id),
      new Map((item.users || []).map(user => [text(user.username).toLowerCase(), user]))]));
    const teamsByProject = new Map((teamResults || []).map(item => [String(item.id),
      new Map((item.teams || []).map(team => [text(team.username || team.name).toLowerCase(), team]))]));
    const rows = [];
    for (const project of projects || []) {
      if (!selectedProjects.has(project.id)) continue;
      const users = usersByProject.get(project.id) || new Map();
      const teams = teamsByProject.get(project.id) || new Map();
      for (const credential of project.credentials || []) {
        const username = text(credential.username);
        if (!username) continue;
        const user = users.get(username.toLowerCase());
        const teamName = text(user?.team);
        const team = teams.get(teamName.toLowerCase());
        const state = user ? (user.exists ? (user.role === 'admin' ? 'Admin' : 'Exists') : 'Missing')
          : errors[project.id] ? 'Error' : '—';
        rows.push({project, username, user, teamName, team,
          userRank: user?.exists ? rank(user.rank) : null,
          userPoints: user?.exists ? number(user.score) : null,
          teamRank: team ? rank(team.rank) : null,
          teamPoints: team ? number(team.score) : null,
          completed: user?.exists ? number(user.completed) : null,
          state});
      }
    }
    return rows;
  }

  function filterRows(rows, query, regex = false) {
    const needle = text(query);
    if (!needle) return {rows, error: false};
    let matcher;
    try {
      const pattern = regex ? new RegExp(needle, 'i') : null;
      matcher = value => regex ? pattern.test(text(value)) : text(value).toLowerCase().includes(needle.toLowerCase());
    } catch { return {rows, error: true}; }
    return {rows: rows.filter(row => [
      row.project.name, row.project.tag, row.username, row.teamName, row.user?.hero,
      row.userPoints, row.teamPoints, row.userRank, row.teamRank, row.completed, row.state,
    ].some(matcher)), error: false};
  }

  function sortRows(rows, sort, userMode = 'name', teamMode = 'name') {
    const key = sort?.key || 'user';
    const direction = sort?.dir === 'desc' ? -1 : 1;
    const value = row => {
      if (key === 'project') return text(row.project.name).toLowerCase();
      if (key === 'user') return userMode === 'rank' ? row.userRank : row.username.toLowerCase();
      if (key === 'team') return teamMode === 'rank' ? row.teamRank : row.teamName.toLowerCase() || null;
      if (key === 'user_points') return row.userPoints;
      if (key === 'team_points') return row.teamPoints;
      if (key === 'completed') return row.completed;
      if (key === 'character') return text(row.user?.hero).toLowerCase() || null;
      if (key === 'state') return row.state === '—' ? null : row.state.toLowerCase();
      return row.username.toLowerCase();
    };
    return [...rows].sort((a, b) => {
      const left = value(a), right = value(b);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left === null && right === null) return 0;
      if (left < right) return -direction;
      if (left > right) return direction;
      if (key === 'user' && userMode === 'rank' || key === 'team' && teamMode === 'rank') {
        const leftName = (key === 'user' ? a.username : a.teamName).toLowerCase();
        const rightName = (key === 'user' ? b.username : b.teamName).toLowerCase();
        if (leftName < rightName) return -direction;
        if (leftName > rightName) return direction;
      }
      return 0;
    });
  }

  window.CTFRPG_Table = {buildRows, filterRows, sortRows};
})();
