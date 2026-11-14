const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { before, after, beforeEach, test } = require('node:test');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { ref, get, set, update, remove, serverTimestamp } = require('firebase/database');

let environment;
const projectId = 'demo-translation';
const original = {
  original: 'Урон 10', translation: 'Damage 10', translationAuthor: 'translator', translationAuthorName: 'Translator',
  confirmed: true, confirmedBy: 'editor', confirmedByName: 'Editor', inactive: false,
  lastConfirmedTranslation: 'Damage 10', lastConfirmedTranslationAuthor: 'translator',
  lastConfirmedTranslationAuthorName: 'Translator', lastConfirmedBy: 'editor', lastConfirmedByName: 'Editor', lastConfirmedAt: 123,
  userComments: { existing: { author: 'other', authorName: 'Other', text: 'Existing', timestamp: 10 } }
};
const fixture = () => ({
  users: {
    translator: { displayName: 'Translator', role: 'translator' },
    editor: { displayName: 'Editor', role: 'editor' },
    admin: { displayName: 'Admin', role: 'editor', canManageDb: true },
    other: { displayName: 'Other', role: 'translator' }
  },
  strings: { 1: original, 2: { ...original, original: 'Урон 20', translation: 'Damage 20' } },
  metadata: { revision: 0, importedNumbers: ['1','2'], lastImportStructure: [{id:'1',content:'Урон 10'}] }
});
const database = uid => uid ? environment.authenticatedContext(uid).database() : environment.unauthenticatedContext().database();
const commit = (uid, patch, revision = 1) => update(ref(database(uid)), { ...patch, 'metadata/revision': revision });
const translationPatch = (key, text = 'New translation') => ({
  [`strings/${key}/translation`]: text,
  [`strings/${key}/confirmed`]: false,
  [`strings/${key}/confirmedBy`]: '', [`strings/${key}/confirmedByName`]: ''
});

before(async () => {
  const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
  environment = await initializeTestEnvironment({ projectId, database: {
    host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8')
  } });
});
after(async () => { if (environment) await environment.cleanup(); });
beforeEach(async () => {
  await environment.withSecurityRulesDisabled(async context => set(ref(context.database()), fixture()));
});

test('signed-out users cannot read or write content', async () => {
  await assertFails(get(ref(database(), 'strings')));
  await assertFails(commit(null, translationPatch('1')));
});

test('members read content and their own profile, without listing other profiles', async () => {
  await assertSucceeds(get(ref(database('translator'), 'strings')));
  await assertSucceeds(get(ref(database('translator'), 'metadata')));
  await assertSucceeds(get(ref(database('translator'), 'users/translator')));
  await assertFails(get(ref(database('translator'), 'users')));
  await assertFails(get(ref(database('translator'), 'users/editor')));
  await assertFails(get(ref(database('editor'))));
});

test('users may change their own name and create a name-only profile', async () => {
  await assertSucceeds(update(ref(database('translator'), 'users/translator'), { displayName: 'Renamed' }));
  await assertSucceeds(update(ref(database('new-user'), 'users/new-user'), { displayName: 'New user' }));
  await assertFails(set(ref(database('translator'), 'users/other/displayName'), 'Impersonation'));
});

test('translators and editors cannot promote themselves or another account', async () => {
  for (const uid of ['translator','editor','new-user']) {
    await assertFails(update(ref(database(uid), `users/${uid}`), { role: 'editor', canManageDb: true }));
    await assertFails(set(ref(database(uid), 'users/other/role'), 'editor'));
    await assertFails(remove(ref(database(uid), 'users/admin')));
  }
});

test('the administrator can manage roles and restore a whole database backup', async () => {
  await assertSucceeds(update(ref(database('admin'), 'users/translator'), { role: 'editor' }));
  const replacement = fixture();
  delete replacement.metadata.revision;
  await assertSucceeds(set(ref(database('admin')), replacement));
});

test('a translator edits one translation and clears its approval', async () => {
  await assertSucceeds(commit('translator', translationPatch('1')));
  const saved = (await get(ref(database('translator'), 'strings/1'))).val();
  assert.equal(saved.translation, 'New translation');
  assert.equal(saved.confirmed, false);
  assert.equal(saved.lastConfirmedTranslation, 'Damage 10');
});

test('translators edit a group atomically with independent text for each member', async () => {
  await assertSucceeds(commit('translator', { ...translationPatch('1','New 10'), ...translationPatch('2','New 20'),
    'strings/2/lastConfirmedTranslation': 'Damage 20' }));
  assert.equal((await get(ref(database('translator'), 'strings/2/translation'))).val(), 'New 20');
});

test('a new translator can save an unconfirmed legacy record', async () => {
  await environment.withSecurityRulesDisabled(async context => {
    await set(ref(context.database(), 'strings/3'), { original: 'Оригинал', translation: '' });
  });
  await assertSucceeds(commit('translator', {
    'strings/3/translation': 'English', 'strings/3/translationAuthor': 'translator', 'strings/3/translationAuthorName': 'Translator'
  }));
});

test('a translation change cannot retain approval, forge attribution or corrupt history', async () => {
  await assertFails(commit('translator', { 'strings/1/translation': 'Unreviewed' }));
  await assertFails(commit('translator', { ...translationPatch('1'), 'strings/1/translationAuthor': 'editor' }));
  await assertFails(commit('translator', { ...translationPatch('1'), 'strings/1/lastConfirmedTranslation': 'Forged' }));
  await assertFails(commit('translator', { ...translationPatch('1'), 'strings/1/confirmed': true }));
});

test('translators cannot change originals, activity, imports or delete phrases', async () => {
  for (const patch of [
    { 'strings/1/original': 'Forged' }, { 'strings/1/inactive': true },
    { 'metadata/importedNumbers': ['99'] }, { 'strings/1': null },
    { 'strings/3': { original: 'Injected', translation: 'Injected' } },
    { 'strings/1/originalEditedBy': 'editor' }
  ]) await assertFails(commit('translator', patch));
});

test('ordinary accounts and editors cannot replace or delete the entire database', async () => {
  for (const uid of ['translator','editor']) {
    await assertFails(set(ref(database(uid)), fixture()));
    await assertFails(remove(ref(database(uid))));
    await assertFails(set(ref(database(uid), 'strings'), { 1: original }));
    await assertFails(remove(ref(database(uid), 'strings')));
    await assertFails(update(ref(database(uid)), { strings: {}, users: {} }));
  }
});

test('a translator adds an attributed comment without rewriting existing comments', async () => {
  await assertSucceeds(commit('translator', {
    'strings/1/userComments/new-comment': { author: 'translator', authorName: 'Translator', text: 'New', timestamp: 20 }
  }));
  await assertFails(commit('translator', { 'strings/1/userComments/existing/text': 'Forged' }, 2));
  await assertFails(commit('translator', { 'strings/1/userComments/existing': null }, 2));
  await assertFails(commit('translator', { 'strings/1/userComments': null }, 2));
  await assertFails(commit('translator', {
    'strings/1/userComments/forged': { author: 'editor', authorName: 'Editor', text: 'Fake', timestamp: 30 }
  }, 2));
});

test('editors can confirm, edit originals and activity, import and merge records', async () => {
  await assertSucceeds(commit('editor', { 'strings/1/confirmed': false, 'strings/1/confirmedBy': '', 'strings/1/confirmedByName': '' }));
  await assertSucceeds(commit('editor', { 'strings/1/confirmed': true, 'strings/1/confirmedBy': 'editor', 'strings/1/confirmedByName': 'Editor' }, 2));
  await assertSucceeds(commit('editor', { 'strings/1/original': 'Новый оригинал', 'strings/1/inactive': true,
    'metadata/lastImportStructure/0/content': 'Новый оригинал' }, 3));
  await assertSucceeds(commit('editor', { 'strings/3': original, 'metadata/importedNumbers': ['1','2','3'] }, 4));
  await assertSucceeds(commit('editor', { 'strings/1': null, 'strings/3/translation': 'Merged' }, 5));
});

test('stale revisions reject every path of a batch, including deletes', async () => {
  await assertSucceeds(commit('translator', translationPatch('1')));
  await assertFails(commit('editor', { 'strings/1': null, 'strings/2/original': 'Stale' }));
  assert.equal((await get(ref(database('editor'), 'strings/1/translation'))).val(), 'New translation');
  assert.equal((await get(ref(database('editor'), 'strings/2/original'))).val(), 'Урон 20');
});

test('edits require exactly one revision increment and cannot remove the revision', async () => {
  await assertFails(update(ref(database('translator')), translationPatch('1')));
  await assertFails(commit('translator', translationPatch('1'), 10));
  await assertFails(remove(ref(database('translator'), 'metadata/revision')));
  await assertFails(remove(ref(database('editor'), 'metadata')));
});

test('administrator edits also reject stale revisions', async () => {
  await assertSucceeds(commit('editor', { 'strings/1/inactive': true }));
  await assertFails(commit('admin', { 'strings/1/original': 'Stale' }));
});

test('server permissions take effect immediately after an editor is demoted', async () => {
  await assertSucceeds(set(ref(database('admin'), 'users/editor/role'), 'translator'));
  await assertFails(commit('editor', { 'strings/1/original': 'Unauthorized' }));
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out waiting for site data');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function loadSite(uid) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const elements = new Map();
  const alerts = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, style: {}, classList: { add() {}, remove() {} },
      addEventListener() {}, querySelectorAll: () => [], closest: () => element('label')
    });
    return elements.get(id);
  }
  const client = database(uid);
  const siteDatabase = () => client;
  siteDatabase.ServerValue = { TIMESTAMP: serverTimestamp() };
  const context = vm.createContext({
    console, document: { getElementById: element },
    firebase: { initializeApp() {}, database: siteDatabase, auth: () => ({ onAuthStateChanged() {} }) },
    confirm: () => true, window: { confirm: () => true }, alert: message => alerts.push(message),
    FileReader: class {
      readAsText(file) { Promise.resolve().then(() => this.onload({ target: { result: file.text } })); }
    }
  });
  vm.runInContext(script, context);
  const run = code => vm.runInContext(code, context);
  run(`updateAuthUI({ uid: ${JSON.stringify(uid)} })`);
  await waitFor(() => run('allData.length') === 2 && run('currentDisplayName') === fixture().users[uid].displayName);
  return { run, alerts, element };
}

test('the actual site saves grouped translations and new comments as a translator', async () => {
  const site = await loadSite('translator');
  site.element('groupMode').checked = true;
  await site.run("saveTranslation('1', 'New 10')");
  assert.deepEqual(site.alerts, []);
  assert.equal((await get(ref(database('translator'), 'strings/2/translation'))).val(), 'New 20');
  site.run("handleCommentSave({ currentTarget: { dataset: { key: '1' }, closest: () => ({querySelector: () => ({ value: 'Comment from the site' })}) } })");
  await waitFor(() => site.run('allData[0].userComments.length') === 2 || site.alerts.length > 0);
  assert.deepEqual(site.alerts, []);
});

test('the actual site confirms, restores, edits and imports as an editor', async () => {
  const site = await loadSite('editor');
  await site.run("handleConfirmToggle({ currentTarget: { dataset: { key: '1' }, closest: () => ({querySelector: () => ({ value: 'Damage 10' })}) } })");
  await site.run("handleConfirmToggle({ currentTarget: { dataset: { key: '1' }, closest: () => ({querySelector: () => ({ value: 'Damage 10' })}) } })");
  await site.run("saveTranslation('1', 'Changed')");
  site.run("showLastConfirmedModal('1')");
  await site.run("restoreLastConfirmed('1')");
  assert.deepEqual(site.alerts, []);
  assert.equal((await get(ref(database('editor'), 'strings/1/translation'))).val(), 'Damage 10');
  site.run("saveOriginalEdit('1', 'Новый оригинал')");
  await waitFor(() => site.run("allData[0].original") === 'Новый оригинал' || site.alerts.length > 0);
  assert.deepEqual(site.alerts, []);
  site.run("importTranslationsFromWTS({text:'STRING 1\\n{\\nImported\\n}\\n'})");
  await waitFor(() => site.alerts.length > 0);
  assert(site.alerts[0].includes('Обновлено'), site.alerts.join('\n'));
  assert.equal((await get(ref(database('editor'), 'strings/1/translation'))).val(), 'Imported');
});

test('the actual site updates its role when an administrator changes it', async () => {
  const site = await loadSite('editor');
  await set(ref(database('admin'), 'users/editor/role'), 'translator');
  await waitFor(() => site.run('currentUserRole') === 'translator');
  assert.equal(site.element('importBtn').style.display, 'none');
});

test('a denied site save retains the submitted draft after Firebase rolls back its local update', async () => {
  const site = await loadSite('translator');
  site.run('metadataRevision = -1');
  await site.run("saveTranslation('1', 'Retained draft')");
  assert.equal(site.alerts.length, 1);
  assert.equal(site.run("translationDrafts.get('1')"), 'Retained draft');
  assert.equal((await get(ref(database('translator'), 'strings/1/translation'))).val(), 'Damage 10');
});
