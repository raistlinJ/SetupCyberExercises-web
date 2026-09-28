// Build a reviewable enrollment plan and pin identities before queueing it.
// Selected VM rows identify users; enrollment itself is not scoped to those VMs.
function buildOrchestrationAccessPlan(projects, enabled) {
  const expectedByProject = {}, labels = new Set();
  for (const { project, targets } of projects) {
    if (!project?.id || !Array.isArray(targets) || !targets.length) throw new Error('Select at least one VM row');
    const users = {};
    for (const target of targets) {
      const index = Number(target.index);
      if (!Number.isInteger(index) || index < 1 || index > Number(project.instances)) throw new Error('Invalid selected instance');
      const name = String(project.credentials?.[index - 1]?.username || '').trim();
      if (!name) throw new Error(`No credential username for instance ${index} in ${project.name || project.id}`);
      const userid = name.includes('@') ? name : `${name}@pve`;
      users[String(index)] = userid;
      labels.add(`${userid} — ${project.name || project.id}`);
    }
    expectedByProject[String(project.id)] = users;
  }
  if (!labels.size) throw new Error('Select at least one VM row');
  const recipients = [...labels].join('\n');
  const description = enabled
    ? 'Dangerous: add these existing PVE users to caf-orchestration and caf-maintainers. This also permits updating and rolling back Cyber-agent-flow and ScenarioForge on eligible VMs, affecting everyone using those applications. This grants access to every orchestrator instance using these groups, not just the selected VM rows. Orchestrator 0.6+ permits host-mediated guest commands and file transfers on the user’s PVE-visible VMs and keeps results private per user. Older versions may expose a shared lab view. Native PVE permissions and host shell access are unchanged.'
    : 'Remove these users from caf-orchestration, caf-maintainers and the legacy caf-orchestrator group. This revokes orchestration and application maintenance access. This revokes their access to every orchestrator instance using these groups, including access enrolled from other projects. It does not disable their PVE accounts, change VM permissions, or stop running jobs.';
  return { expectedByProject, message: `${description}\n\nUsers:\n${recipients}\n\nContinue?` };
}
