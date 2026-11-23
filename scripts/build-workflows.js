'use strict';
// Generates importable n8n workflow JSON into workflows/. Code-node bodies embed the
// unit-tested libs in lib/, so the logic that runs in n8n is the logic the tests cover.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const lib = f => fs.readFileSync(path.join(root, 'lib', f), 'utf8').replace(/^'use strict';\n/, '');
const ENGINE = lib('engine.js'), ALL = [lib('normalize-job.js'), lib('plan.js'), ENGINE].join('\n');
const CLIENT = { id: 'vpcred00000000001', name: 'Video Client Key' }, WORKER = { id: 'vpcred00000000002', name: 'Video Worker Key' };
const WF = { setup: 'vpwf000000000000', api: 'vpwf000000000001', gateway: 'vpwf000000000002', sweeper: 'vpwf000000000003', notifier: 'vpwf000000000004' };
const uid = s => { const h = crypto.createHash('md5').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function wf(key, name) {
  const w = { id: WF[key], name, nodes: [], connections: {}, active: false, settings: { executionOrder: 'v1' }, pinData: {} };
  let row = 0;
  const add = (n, x, y) => { n.id = uid(name + n.name); n.position = [x, y]; w.nodes.push(n); return n.name; };
  const link = (a, b, out = 0) => { w.connections[a] = w.connections[a] || { main: [] }; const m = w.connections[a].main; while (m.length <= out) m.push([]); m[out].push({ node: b, type: 'main', index: 0 }); };
  const node = (name, type, tv, parameters, extra = {}) => ({ name, type, typeVersion: tv, parameters, ...extra });
  const T = {
    webhook: (name, method, p, cred) => node(name, 'n8n-nodes-base.webhook', 2, { httpMethod: method, path: p, authentication: 'headerAuth', responseMode: 'responseNode', options: {} }, { webhookId: uid('wh' + name), credentials: { httpHeaderAuth: cred } }),
    code: (name, glue, libs = ENGINE) => node(name, 'n8n-nodes-base.code', 2, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: (libs ? libs + '\n' : '') + glue }),
    respond: name => node(name, 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: '={{ $json.body }}', options: { responseCode: '={{ $json.status }}' } }),
    iff: (name, expr) => node(name, 'n8n-nodes-base.if', 2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ id: uid('c' + name), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }),
    dt: (name, op, o = {}) => node(name, 'n8n-nodes-base.dataTable', 1.1, Object.assign({ resource: 'row', operation: op, dataTableId: { __rl: true, mode: 'name', value: 'video_jobs' } },
      o.filters ? { matchType: 'allConditions', filters: { conditions: o.filters.map(f => ({ keyName: f[0], condition: f[1], keyValue: f[2] })) } } : {},
      (op === 'insert' || op === 'update') ? { columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [], schema: [] } } : {},
      op === 'get' ? { returnAll: false, limit: o.limit || 50, orderBy: !!o.orderBy, orderByColumn: o.orderBy ? o.orderBy[0] : undefined, orderByDirection: o.orderBy ? o.orderBy[1] : undefined } : {}), { alwaysOutputData: !!o.always }),
  };
  return { w, add, link, T, node, next: () => row++ };
}
const save = (w, file) => fs.writeFileSync(path.join(root, 'workflows', file), JSON.stringify(w, null, 2) + '\n');
const J = '$input.first().json';

// ------------------------------------------------------------------ VP-00 Setup
{
  const { w, add, T, node, link } = wf('setup', 'VP-00 Setup (creates the job table)');
  const trig = add(node('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, {}), 0, 0);
  const hook = add(T.webhook('Setup: Webhook', 'POST', 'video-setup', CLIENT), 0, 200);
  const cols = [['job_id', 'string'], ['state', 'string'], ['kind', 'string'], ['priority', 'number'], ['created_ms', 'number'], ['updated_ms', 'number'], ['lease_ms', 'number'], ['not_before_ms', 'number'], ['worker_id', 'string'], ['attempts', 'number'], ['max_attempts', 'number'], ['cancel_requested', 'boolean'], ['progress', 'number'], ['stage', 'string'], ['message', 'string'], ['idem_key', 'string'], ['data', 'string']];
  const t = add(node('Create video_jobs table', 'n8n-nodes-base.dataTable', 1.1, { resource: 'table', operation: 'create', tableName: 'video_jobs', columns: { column: cols.map(c => ({ name: c[0], type: c[1] })) }, options: { createIfNotExists: true } }), 240, 100);
  const rp = add(T.code('Setup: Reply', `return [{json:{status:200,body:{ok:true,table:'video_jobs',note:'job table is ready'}}}];`, ''), 480, 100);
  const rs = add(T.respond('Setup: Respond'), 720, 100);
  link(trig, t); link(hook, t); link(t, rp); link(rp, rs); save(w, 'VP-00-setup.json');
}

// ------------------------------------------------------------------ VP-01 Job API
{
  const { w, add, link, T, node } = wf('api', 'VP-01 Video Job API');
  let y = 0; const lane = () => (y += 260) - 260;
  const respond = (name, x, yy) => add(T.respond(name), x, yy);
  // submit
  { const Y = lane(); const a = add(T.webhook('Submit: Webhook', 'POST', 'video-jobs', CLIENT), 0, Y);
    const b = add(T.code('Submit: Prepare', `const body=${J}.body||{}; const now=Date.now(); const r=prepareSubmit(body,now,newJobId(now)); return [{json:{status:r.status,body:r.body,row:r.row||null,idem:(body&&body.idempotency_key)||''}}];`, ALL), 220, Y);
    const c = add(T.dt('Submit: Find duplicate', 'get', { filters: [['idem_key', 'eq', "={{ $json.idem || '__none__' }}"]], limit: 1, always: true }), 440, Y);
    const d = add(T.code('Submit: Decide', `const prep=$('Submit: Prepare').first().json; const found=$input.all().map(i=>i.json).filter(r=>r.job_id);
if(prep.status!==202) return [{json:{action:'respond',status:prep.status,body:prep.body}}];
if(prep.idem && found.length) return [{json:{action:'respond',status:200,body:{ok:true,duplicate:true,job_id:found[0].job_id,state:found[0].state}}}];
return [{json:{action:'insert',status:202,body:prep.body}}];`, ''), 660, Y);
    const e = add(T.iff('Submit: Insert?', "={{ $json.action === 'insert' }}"), 880, Y);
    const f = add(T.code('Submit: Row', `return [{json: $('Submit: Prepare').first().json.row}];`, ''), 1100, Y - 80);
    const g = add(T.dt('Submit: Insert', 'insert'), 1320, Y - 80);
    const h = add(T.code('Submit: Reply', `return [{json:{status:202, body:$('Submit: Decide').first().json.body}}];`, ''), 1540, Y - 80);
    const r = respond('Submit: Respond', 1760, Y);
    link(a, b); link(b, c); link(c, d); link(d, e); link(e, f, 0); link(f, g); link(g, h); link(h, r); link(e, r, 1); }
  // validate (dry run)
  { const Y = lane(); const a = add(T.webhook('Validate: Webhook', 'POST', 'video-jobs/validate', CLIENT), 0, Y);
    const b = add(T.code('Validate: Check', `const body=${J}.body||{}; const now=Date.now(); const r=prepareSubmit(body,now,'job_dryrun'); if(r.status!==202) return [{json:{status:400,body:r.body}}];
const b={ok:true,dry_run:true,would_start_in_state:r.body.state,defaults_applied:r.body.defaults_applied,warnings:r.body.warnings,outputs:JSON.parse(r.row.data).outputs}; return [{json:{status:200,body:b}}];`, ALL), 220, Y);
    const r = respond('Validate: Respond', 440, Y); link(a, b); link(b, r); }
  // status
  { const Y = lane(); const a = add(T.webhook('Status: Webhook', 'GET', 'video-jobs/status', CLIENT), 0, Y);
    const b = add(T.dt('Status: Get', 'get', { filters: [['job_id', 'eq', "={{ $json.query.job_id || '__none__' }}"]], limit: 1, always: true }), 220, Y);
    const c = add(T.code('Status: View', `const rows=$input.all().map(i=>i.json).filter(r=>r.job_id); if(!rows.length) return [{json:{status:404,body:{ok:false,errors:['job not found']}}}];
const q=$('Status: Webhook').first().json.query||{}; return [{json:{status:200,body:{ok:true,job:publicView(rows[0], q.full==='1')}}}];`), 440, Y);
    const r = respond('Status: Respond', 660, Y); link(a, b); link(b, c); link(c, r); }
  // list
  { const Y = lane(); const a = add(T.webhook('List: Webhook', 'GET', 'video-jobs/list', CLIENT), 0, Y);
    const b = add(T.dt('List: Get', 'get', { limit: 100, orderBy: ['created_ms', 'DESC'], always: true }), 220, Y);
    const c = add(T.code('List: View', `const q=$('List: Webhook').first().json.query||{}; let rows=$input.all().map(i=>i.json).filter(r=>r.job_id);
if(q.state) rows=rows.filter(r=>r.state===q.state); if(q.kind) rows=rows.filter(r=>r.kind===q.kind);
const lim=Math.min(50,+q.limit||20); const jobs=rows.slice(0,lim).map(r=>{const v=publicView(r,false); delete v.history; return v;});
return [{json:{status:200,body:{ok:true,count:jobs.length,jobs}}}];`), 440, Y);
    const r = respond('List: Respond', 660, Y); link(a, b); link(b, c); link(c, r); }
  // mutate chains
  const mutate = (P, path, decideGlue) => { const Y = lane();
    const a = add(T.webhook(`${P}: Webhook`, 'POST', path, CLIENT), 0, Y);
    const b = add(T.dt(`${P}: Get`, 'get', { filters: [['job_id', 'eq', "={{ $json.body.job_id || '__none__' }}"]], limit: 1, always: true }), 220, Y);
    const c = add(T.code(`${P}: Decide`, `const rows=$input.all().map(i=>i.json).filter(r=>r.job_id); const body=$('${P}: Webhook').first().json.body||{}; const now=Date.now();
if(!rows.length) return [{json:{status:404,body:{ok:false,errors:['job not found']}}}];
${decideGlue}`, ALL), 440, Y);
    const d = add(T.iff(`${P}: Update?`, '={{ !!$json.update }}'), 660, Y);
    const e = add(T.code(`${P}: Row`, `return [{json: $('${P}: Decide').first().json.update}];`, ''), 880, Y - 80);
    const f = add(T.dt(`${P}: Update`, 'update', { filters: [['job_id', 'eq', '={{ $json.job_id }}'], ['state', 'eq', `={{ $('${P}: Decide').first().json.expect_state }}`]], always: true }), 1100, Y - 80);
    const g = add(T.code(`${P}: Reply`, `const d=$('${P}: Decide').first().json; const n=$input.all().filter(i=>i.json.job_id).length;
if(!n) return [{json:{status:409,body:{ok:false,errors:['job changed while updating; fetch status and retry']}}}]; return [{json:{status:d.status,body:d.body}}];`, ''), 1320, Y - 80);
    const r = respond(`${P}: Respond`, 1540, Y);
    link(a, b); link(b, c); link(c, d); link(d, e, 0); link(e, f); link(f, g); link(g, r); link(d, r, 1); };
  mutate('Plan', 'video-jobs/plan', `if(typeof body.plan!=='object'||!body.plan) return [{json:{status:400,body:{ok:false,errors:['plan object required']}}}]; const r=planAttach(rows[0],body.plan,now); return [{json:r}];`);
  mutate('Cancel', 'video-jobs/cancel', `return [{json:cancel(rows[0],now)}];`);
  mutate('Retry', 'video-jobs/retry', `return [{json:retry(rows[0],now)}];`);
  save(w, 'VP-01-job-api.json');
}

// ------------------------------------------------------------------ VP-02 Worker Gateway
{
  const { w, add, link, T, node } = wf('gateway', 'VP-02 Worker Gateway');
  let y = 0; const lane = () => (y += 280) - 280; const respond = (n, x, yy) => add(T.respond(n), x, yy);
  const notifyBranch = (src, P, x, Y) => { const i = add(T.iff(`${P}: Notify?`, '={{ !!$json.notify }}'), x, Y + 120);
    const n = add(T.code(`${P}: Notify item`, `return [{json:{job_id:$('${P}: Decide').first().json.job_id}}];`, ''), x + 220, Y + 120);
    const e = add(node(`${P}: Call Notifier`, 'n8n-nodes-base.executeWorkflow', 1.2, { source: 'database', workflowId: { __rl: true, mode: 'id', value: WF.notifier }, workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: false }, options: { waitForSubWorkflow: false } }), x + 440, Y + 120);
    link(src, i); link(i, n, 0); link(n, e); };
  // claim
  { const Y = lane(); const a = add(T.webhook('Claim: Webhook', 'POST', 'video-worker/claim', WORKER), 0, Y);
    const b = add(T.dt('Claim: Queued jobs', 'get', { filters: [['state', 'eq', 'queued']], limit: 50, orderBy: ['created_ms', 'ASC'], always: true }), 220, Y);
    const c = add(T.code('Claim: Pick', `const rows=$input.all().map(i=>i.json).filter(r=>r.job_id); const wb=$('Claim: Webhook').first().json.body||{}; const now=Date.now(); const wid=String(wb.worker_id||'worker');
if(wb.busy) return [{json:{status:200,body:{ok:true,job:null,note:'worker busy'}}}];
const r=claimPick(rows,now); if(!r) return [{json:{status:200,body:{ok:true,job:null}}}];
return [{json:{status:200,body:claimBody(r,wid),update:claimUpdate(r,wid,now)}}];`), 440, Y);
    const d = add(T.iff('Claim: Found?', '={{ !!$json.update }}'), 660, Y);
    const e = add(T.code('Claim: Row', `return [{json: $('Claim: Pick').first().json.update}];`, ''), 880, Y - 80);
    const f = add(T.dt('Claim: Lock job', 'update', { filters: [['job_id', 'eq', '={{ $json.job_id }}'], ['state', 'eq', 'queued']], always: true }), 1100, Y - 80);
    const g = add(T.code('Claim: Reply', `const n=$input.all().filter(i=>i.json.job_id).length; const p=$('Claim: Pick').first().json; if(!n) return [{json:{status:200,body:{ok:true,job:null,note:'raced; poll again'}}}]; return [{json:{status:200,body:p.body}}];`, ''), 1320, Y - 80);
    const r = respond('Claim: Respond', 1540, Y); link(a, b); link(b, c); link(c, d); link(d, e, 0); link(e, f); link(f, g); link(g, r); link(d, r, 1); }
  // progress
  { const Y = lane(); const a = add(T.webhook('Progress: Webhook', 'POST', 'video-worker/progress', WORKER), 0, Y);
    const b = add(T.code('Progress: Prepare', `const b=${J}.body||{}; return [{json:progressUpdate(b,Date.now())}];`), 220, Y);
    const c = add(T.dt('Progress: Update', 'update', { filters: [['job_id', 'eq', '={{ $json.job_id }}'], ['worker_id', 'eq', "={{ $('Progress: Webhook').first().json.body.worker_id }}"], ['state', 'eq', 'running']], always: true }), 440, Y);
    const d = add(T.code('Progress: Reply', `const r=$input.all().map(i=>i.json).find(x=>x.job_id); if(!r) return [{json:{status:409,body:{ok:false,cancel:true,reason:'not the running owner of this job (cancelled, finished or requeued)'}}}];
return [{json:{status:200,body:{ok:true,cancel:!!r.cancel_requested}}}];`, ''), 660, Y);
    const r = respond('Progress: Respond', 880, Y); link(a, b); link(b, c); link(c, d); link(d, r); }
  // complete / fail
  const finish = (P, path, glue) => { const Y = lane(); const a = add(T.webhook(`${P}: Webhook`, 'POST', path, WORKER), 0, Y);
    const b = add(T.dt(`${P}: Get`, 'get', { filters: [['job_id', 'eq', "={{ $json.body.job_id || '__none__' }}"]], limit: 1, always: true }), 220, Y);
    const c = add(T.code(`${P}: Decide`, `const rows=$input.all().map(i=>i.json).filter(r=>r.job_id); const b=$('${P}: Webhook').first().json.body||{}; const now=Date.now();
if(!rows.length) return [{json:{status:404,body:{ok:false,errors:['job not found']}}}];
const row=rows[0]; if(row.state!=='running'||row.worker_id!==b.worker_id) return [{json:{status:409,body:{ok:false,reason:'job is '+row.state+' and owned by '+(row.worker_id||'nobody')}}}];
${glue}`), 440, Y);
    const d = add(T.iff(`${P}: Update?`, '={{ !!$json.update }}'), 660, Y);
    const e = add(T.code(`${P}: Row`, `return [{json: $('${P}: Decide').first().json.update}];`, ''), 880, Y - 80);
    const f = add(T.dt(`${P}: Update`, 'update', { filters: [['job_id', 'eq', '={{ $json.job_id }}'], ['state', 'eq', 'running'], ['worker_id', 'eq', `={{ $('${P}: Webhook').first().json.body.worker_id }}`]], always: true }), 1100, Y - 80);
    const g = add(T.code(`${P}: Reply`, `const d=$('${P}: Decide').first().json; const n=$input.all().filter(i=>i.json.job_id).length; if(!n) return [{json:{status:409,body:{ok:false,reason:'job changed while updating'}}}];
return [{json:{status:200,body:{ok:true,state:d.final_state},notify:d.notify}}];`, ''), 1320, Y - 80);
    const r = respond(`${P}: Respond`, 1540, Y - 80); link(a, b); link(b, c); link(c, d); link(d, e, 0); link(e, f); link(f, g); link(g, r); link(d, r, 1); notifyBranch(g, P, 1540, Y); };
  finish('Complete', 'video-worker/complete', `const x=completeDecision(row,b,now); return [{json:{job_id:row.job_id,update:x.update,final_state:x.state,notify:!!dataOf(row).callback_url,status:200,body:{ok:true}}}];`);
  finish('Fail', 'video-worker/fail', `const x=failDecision(row,b.error||{},now); return [{json:{job_id:row.job_id,update:x.update,final_state:x.state,notify:!!dataOf(row).callback_url&&x.state!=='queued',status:200,body:{ok:true}}}];`);
  save(w, 'VP-02-worker-gateway.json');
}

// ------------------------------------------------------------------ VP-03 Recovery Sweeper
{
  const { w, add, link, T, node } = wf('sweeper', 'VP-03 Recovery Sweeper');
  const s = add(node('Every minute', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } }), 0, 0);
  // expired leases -> requeue or fail
  const a = add(T.dt('Expired leases', 'get', { filters: [['state', 'eq', 'running'], ['lease_ms', 'lt', '={{ Date.now() }}']], limit: 50, always: true }), 240, 0);
  const b = add(T.code('Requeue or fail', `const now=Date.now(); return $input.all().map(i=>i.json).filter(r=>r.job_id).map(r=>({json:sweepDecision(r,now).update}));`), 480, 0);
  const c = add(T.dt('Apply (lease)', 'update', { filters: [['job_id', 'eq', '={{ $json.job_id }}'], ['state', 'eq', 'running']] }), 720, 0);
  link(s, a); link(a, b); link(b, c);
  // plan never attached
  const d = add(T.dt('Plans overdue', 'get', { filters: [['state', 'eq', 'awaiting_plan'], ['created_ms', 'lt', '={{ Date.now() - 86400000 }}']], limit: 50, always: true }), 240, 220);
  const e = add(T.code('Expire plan wait', `const now=Date.now(); return $input.all().map(i=>i.json).filter(r=>r.job_id).map(r=>({json:stalePlan(r,now)}));`), 480, 220);
  const f = add(T.dt('Apply (plan timeout)', 'update', { filters: [['job_id', 'eq', '={{ $json.job_id }}'], ['state', 'eq', 'awaiting_plan']] }), 720, 220);
  link(s, d); link(d, e); link(e, f);
  // retention: job RECORDS only; uploaded/original media is never touched
  const g = add(T.dt('Old finished jobs', 'get', { filters: [['updated_ms', 'lt', '={{ Date.now() - 30*86400000 }}']], limit: 50, always: true }), 240, 440);
  const h = add(T.code('Pick finished', `return $input.all().map(i=>i.json).filter(r=>r.job_id && ['completed','failed','cancelled'].includes(r.state)).map(r=>({json:{job_id:r.job_id}}));`, ''), 480, 440);
  const i = add(T.dt('Delete job record', 'deleteRows', { filters: [['job_id', 'eq', '={{ $json.job_id }}']] }), 720, 440);
  link(s, g); link(g, h); link(h, i);
  save(w, 'VP-03-recovery-sweeper.json');
}

// ------------------------------------------------------------------ VP-04 Notifier
{
  const { w, add, link, T, node } = wf('notifier', 'VP-04 Completion Notifier');
  const a = add(node('Execute Workflow Trigger', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' }), 0, 0);
  const b = add(T.dt('Get job', 'get', { filters: [['job_id', 'eq', "={{ $json.job_id || '__none__' }}"]], limit: 1, always: true }), 220, 0);
  const c = add(T.code('Build payload', `const r=$input.all().map(i=>i.json).find(x=>x.job_id); if(!r) return []; const d=dataOf(r); if(!d.callback_url) return []; return [{json:{url:d.callback_url,payload:notifyPayload(r)}}];`), 440, 0);
  const d = add(node('POST callback', 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: '={{ $json.url }}', sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Video-Event', value: '={{ $json.payload.event }}' }] }, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.payload) }}', options: { timeout: 15000 } }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' }), 660, 0);
  link(a, b); link(b, c); link(c, d); save(w, 'VP-04-notifier.json');
}
console.log('workflows written');
