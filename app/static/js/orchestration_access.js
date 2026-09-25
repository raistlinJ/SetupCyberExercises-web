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
    ? 'Dangerous: add these existing PVE users to caf-orchestrator. This grants access to every orchestrator instance using this group and its configured lab/results, not just the selected VM rows. The current WebUI is read-only; future execution features can provide host-mediated file transfers and command execution. PVE VM permissions and host shell access are unchanged.'
    : 'Remove these users from caf-orchestrator. This revokes their access to every orchestrator instance using this group, including access enrolled from other projects. It does not disable their PVE accounts, change VM permissions, or stop running jobs.';
  return { expectedByProject, message: `${description}\n\nUsers:\n${recipients}\n\nContinue?` };
}
