# Per-instance command template variables

Startup, stored, validation, and custom guest commands can use literal `{{variable_name}}` placeholders. Values are resolved separately for each selected guest. Shell variables, JSON, and ordinary braces are unchanged. Expressions and Python/Jinja evaluation are not supported.

| Variable | Value |
|---|---|
| `{{instance_index}}` | Stable 1-based scenario instance index |
| `{{vmid}}` | Current resolved Proxmox guest ID |
| `{{vm_name}}` | Generated guest name |
| `{{project_id}}` | Project ID |


These substitutions apply to startup/stored/validation/custom command text, including stored-command overrides. Validation match patterns and agent-generated commands retain their literal behavior. When rendering is enabled, unknown names, unavailable values, and metadata containing shell metacharacters produce a command error before that command is dispatched. Commands without placeholders are passed through unchanged. Reserve `{{name}}` syntax for substitution in these command fields.

Saved commands retain placeholders. Execution logs and downloaded outputs record the rendered or literal command actually sent to the guest.

## Render or send literally

Each startup/stored/validation command has a **Render template variables** switch. It is on by default. Switch it off to send placeholders such as `{{instance_index}}` or another application's `{{name}}` literally. The choice is saved per command and preserved when reopening, exporting or importing the project.

**Custom Command** has the same switch. Its setting travels with queued execution and is restored when recalling a command from history. This controls SCE-web's substitution only; the guest shell or an application may still interpret the command it receives.

The **Run Stored Command** dialog also shows a **Render template variables** switch for each command. It starts with the saved setting. Changes in this dialog apply only to that run, including queued execution. A mixed indicator means the grouped commands have different saved settings; leaving it unchanged preserves those settings.

## Preview commands

Expand **Advanced** in **Manage Start Commands**, **Manage Stored Commands**, **Manage Validation Commands**, or **Custom Command** to access **Template variables and command preview**. This section is collapsed by default. Click the small **?** button to show or hide all available variables and their meanings.

In the startup/stored/validation editors, choose an instance index and click **Preview commands**. It previews enabled commands from the current editor text, including unsaved edits. Each result is labeled **Rendered** or **Literal** according to that command's switch. Custom Command previews the currently selected VMs across their projects, using known inventory VMIDs where available. Preview does not contact Proxmox, enqueue work, or execute commands. Editing the command or settings marks an existing preview as outdated.

Use the **Preview result** dropdown to view one command for one VM at a time. Options identify the project, VM, instance, command number, and render mode. The first result is selected initially; switching results does not make another request. Commands without template placeholders, or with rendering disabled, are previewed immediately in the browser. Requests that need server rendering time out after 10 seconds with a retry message.

VMID is optional preview metadata. Supply the current inventory VMID for a preview using `{{vmid}}`; otherwise that variable reports unavailable. Execution always uses the server-resolved VMID, rather than the preview value.

## Preview API

`POST /api/projects/<project_id>/commands/preview` accepts:

```json
{
  "targets": [{"index": 7, "name": "core", "vmid": 1707}],
  "commands": ["echo {{instance_index}} {{vm_name}}"]
}
```

Command entries can also be objects such as `{"command": "echo {{literal}}", "render_template_variables": false}`. Strings retain the default of rendering enabled. The custom-command execution API accepts the boolean `renderTemplateVariables`; saved startup/stored/validation entries use `render_template_variables`.

It returns `previews` containing per-target variables, command text or errors, plus `variable_descriptions`. VMID is preview metadata and grants no execution capability.


## Derive application-specific values in commands

SCE-web provides project and guest metadata. A command can use `{{instance_index}}` to calculate addresses, filenames, or other application-specific settings. Those calculations and any collision checks belong to your command or external tooling.

For example, this shell command derives a decimal IP octet and a hexadecimal MAC byte:

```bash
instance_index="{{instance_index}}"
router_ip="11.0.0.${instance_index}"
router_mac="$(printf '00:00:00:aa:00:%02x' "$instance_index")"
printf '%s %s\n' "$router_ip" "$router_mac"
```

Instance 7 produces `11.0.0.7` and `00:00:00:aa:00:07`; instance 60 produces `11.0.0.60` and `00:00:00:aa:00:3c`. Validate the index against your chosen subnet and reserved addresses before applying network changes.
