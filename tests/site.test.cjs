const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.SITE_HTML || path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const clone = value => JSON.parse(JSON.stringify(value));

function createSite(initial = { strings: {}, metadata: {} }) {
  let data = clone(initial);
  let beforeUpdate;
  let nextComment = 0;
  const listeners = new Map();
  const elements = new Map();
  const alerts = [];
  const writes = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, style: {}, dataset: {}, innerHTML: '',
      classList: { add() {}, remove() {} }, addEventListener() {},
      querySelectorAll() { return []; }, closest() { return element('label'); }
    });
    return elements.get(id);
  }
  const get = location => location.split('/').filter(Boolean).reduce((value, key) => value?.[key], data) ?? null;
  const snapshot = value => ({ val: () => clone(value) });
  function emit() {
    for (const [location, callbacks] of listeners) {
      if (location.startsWith('.')) continue;
      for (const callback of callbacks) callback(snapshot(get(location)));
    }
  }
  function ref(location = '') {
    return {
      child: child => ref([location, child].filter(Boolean).join('/')),
      push: () => ({ key: `comment-${++nextComment}` }),
      off() { listeners.delete(location); },
      on(event, callback) {
        if (!listeners.has(location)) listeners.set(location, []);
        listeners.get(location).push(callback);
      },
      once(event, callback) {
        return Promise.resolve().then(() => {
          const value = snapshot(get(location));
          if (callback) callback(value);
          return value;
        });
      },
      async update(updates) {
        if (beforeUpdate) {
          const action = beforeUpdate;
          beforeUpdate = undefined;
          action(data);
          data.metadata.revision = (data.metadata.revision || 0) + 1;
        }
        if (location === '' && updates['metadata/revision'] !== (data.metadata.revision || 0) + 1) {
          throw Object.assign(new Error('Version conflict'), { code: 'PERMISSION_DENIED' });
        }
        for (const [field, value] of Object.entries(updates)) {
          const parts = [location, field].filter(Boolean).join('/').split('/');
          const key = parts.pop();
          let parent = data;
          for (const part of parts) parent = parent[part] || (parent[part] = {});
          if (value === null) delete parent[key];
          else parent[key] = clone(value);
        }
        writes.push(location);
        emit();
      }
    };
  }
  const database = () => ({ ref });
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  const context = vm.createContext({
    console: { log() {}, error() {} },
    document: { getElementById: element },
    firebase: { initializeApp() {}, database, auth: () => ({ onAuthStateChanged() {} }) },
    window: { confirm: () => true }, confirm: () => true, alert: message => alerts.push(message),
    FileReader: class {
      readAsText(file) { Promise.resolve().then(() => this.onload({ target: { result: file.text } })); }
    }
  });
  vm.runInContext(script, context);
  emit();
  return {
    run: source => vm.runInContext(source, context),
    data: () => data, alerts, writes, element,
    replace(next) { data = clone(next); emit(); },
    beforeWrite(action) { beforeUpdate = action; }
  };
}

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function editor(site) {
  site.run("currentUser = { uid: 'editor' }; currentUserRole = 'editor'; currentDisplayName = 'Editor';");
}
const entry = (original, translation = 'Translation', extra = {}) => ({ original, translation, confirmed: true, ...extra });
const wts = (id, text) => `STRING ${id}\n{\n${text}\n}\n`;

test('repeated words never produce a similarity over 100%', () => {
  const site = createSite({ strings: { 2: entry('огонь щит') }, metadata: {} });
  const results = site.run("findSimilarConfirmedTranslations('огонь огонь огонь огонь', '1')");
  assert.equal(results.length, 1);
  assert(results[0].score > 0 && results[0].score <= 1);
  assert.equal(new Set(results[0].commonWords).size, results[0].commonWords.length);
});

test('colors, line breaks, punctuation, ё and short words normalize consistently', () => {
  const site = createSite({ strings: { 2: entry('Еж и яд 05') }, metadata: {} });
  const [match] = site.run("findSimilarConfirmedTranslations('|cFFFF0000Ёж|R|nи-яд 05', '1')");
  assert.equal(match.score, 1);
  assert.equal(match.exact, true);
});

test('similar spellings and endings work without an exact shared word', () => {
  const site = createSite({ strings: { 2: entry('замедление') }, metadata: {} });
  assert.equal(site.run("findSimilarConfirmedTranslations('замедления', '1')").length, 1);
});

test('rare shared terms rank above common words', () => {
  const strings = { 1: entry('щит ветер'), 2: entry('телепорт ветер') };
  for (let key = 3; key < 30; key++) strings[key] = entry(`щит значение${key}`);
  const site = createSite({ strings, metadata: {} });
  assert.equal(site.run("findSimilarConfirmedTranslations('щит телепорт', '0')")[0].key, '2');
});

test('excludes self, inactive, empty and unconfirmed entries and removes duplicate suggestions', () => {
  const site = createSite({
    strings: {
      1: entry('огонь'), 2: entry('огонь'), 3: entry('огонь'),
      4: entry('огонь', 'Other translation'), 5: entry('огонь', '', {}),
      6: entry('огонь', 'Translation', { inactive: true }),
      7: entry('огонь', 'Translation', { confirmed: false })
    }, metadata: {}
  });
  assert.deepEqual(Array.from(site.run("findSimilarConfirmedTranslations('огонь', '1')"), item => item.key), ['2', '4']);
  assert.equal(site.run("findSimilarConfirmedTranslations('|cFFFFFFFF|r!!!', '1')").length, 0);
  assert.equal(site.run("findSimilarConfirmedTranslations('огонь', '1', 1)").length, 1);
});

test('similarity cache updates after a database event', () => {
  const site = createSite({ strings: { 2: entry('щит огонь') }, metadata: {} });
  assert.equal(site.run("findSimilarConfirmedTranslations('щит огонь', '1')").length, 1);
  site.replace({ strings: { 2: entry('щит огонь', 'Translation', { confirmed: false }) }, metadata: {} });
  assert.equal(site.run("findSimilarConfirmedTranslations('щит огонь', '1')").length, 0);
});

test('similarity display escapes database IDs and translated text', () => {
  const site = createSite({ strings: { 1: entry('щит огонь'), '<img src=x onerror=alert(1)>': entry('щит огонь', '<script>bad</script>') }, metadata: {} });
  site.run("showSimilarTranslations('1')");
  const result = site.element('similarModalList').innerHTML;
  assert(!result.includes('<img'));
  assert(!result.includes('<script>'));
  assert(result.includes('100%'));
});

test('grouped translations preserve numbers inside colors, tags and textures', () => {
  const site = createSite();
  assert.equal(site.run("applyTranslationToMember('|cFF123456Наносит 001.50 <spell12> |TIcon22:32|t|r', '|cAA998877Урон 002.75 <spell77> |TIcon11:64|t')"),
    '|cFF123456Наносит 002.75 <spell12> |TIcon22:32|t|r');
  assert.notEqual(site.run("makePattern('Урон 10 <A001,DataA1>')"), site.run("makePattern('Урон 20 <A002,DataA1>')"));
  assert.equal(site.run("makePattern('Урон 10 <A001,DataA1>')"), site.run("makePattern('Урон 20 <A001,DataA1>')"));
});

test('discarding a draft restores the saved text across rerenders', () => {
  const site = createSite({ strings: { 1: entry('щит', 'Saved') }, metadata: {} });
  const input = { dataset: { key: '1' }, value: 'Draft', _savedValue: 'Saved', style: {} };
  site.element('dictionaryContainer').querySelectorAll = () => [input];
  site.run("translationDrafts.set('1', 'Draft'); renderContent = () => {}; ");
  input.value = 'Saved';
  site.run('render()');
  assert.equal(input.value, 'Saved');
  assert.equal(site.run("translationDrafts.has('1')"), false);
});

test('export preserves original WTS rows when a database entry is missing', () => {
  const site = createSite();
  const result = site.run("generateWTSFromStructure({}, [{id:'1',content:'Missing original'}, {id:'2',content:'',isEmpty:true}])");
  assert.equal(result.count, 2);
  assert.equal(result.emptyCount, 1);
  assert(result.text.includes('Missing original'));
});

test('sparse numeric records from a backup can be displayed, exported and edited', async () => {
  const strings = [null, entry('Оригинал'), null, entry('Другой оригинал')];
  const site = createSite({ strings, metadata: {} });
  assert.equal(site.run('allData.length'), 2);
  assert.equal(site.run("generateWTSFromStructure([null, {original:'Оригинал',translation:'English'}], [{id:'1',content:'Оригинал'}]).count"), 1);
  editor(site);
  site.run("saveOriginalEdit('1', 'Новый оригинал')");
  await flush();
  assert.equal(site.data().strings[1].original, 'Новый оригинал');
});

test('original editing refreshes the displayed data and cancels confirmation', async () => {
  const site = createSite({ strings: { 1: entry('Старый оригинал') }, metadata: { lastImportStructure: [{ id: '1', content: 'Старый оригинал' }] } });
  editor(site);
  site.run("saveOriginalEdit('1', 'Новый оригинал')");
  await flush();
  assert.equal(site.data().strings[1].original, 'Новый оригинал');
  assert.equal(site.run('allData[0].original'), 'Новый оригинал');
  assert.equal(site.data().strings[1].confirmed, false);
  assert.equal(site.data().metadata.lastImportStructure[0].content, 'Новый оригинал');
  assert.equal(site.alerts.length, 0);
});

test('merging originals preserves comments once', async () => {
  const comment = { text: 'Source', author: 'u' };
  const site = createSite({ strings: { 1: entry('Старый оригинал', 'Translation', { userComments: [comment] }), 2: entry('Новый оригинал', '') }, metadata: {} });
  editor(site);
  site.run("saveOriginalEdit('1', 'Новый оригинал')");
  await flush();
  assert(!site.data().strings[1]);
  assert.equal(site.data().strings[2].userComments.length, 1);
  assert.equal(site.run('allData[0].userComments.length'), 1);
});

test('original import preserves extra metadata and translation history', async () => {
  const site = createSite({ strings: { 1: entry('Оригинал', 'Translation', { confirmedBy: 'u' }) }, metadata: { customField: 'Keep' } });
  editor(site);
  site.run(`importWTS({text: ${JSON.stringify(wts(2, 'Оригинал'))}})`);
  await flush();
  assert.equal(site.data().strings[2].translation, 'Translation');
  assert.equal(site.data().strings[2].lastConfirmedTranslation, 'Translation');
  assert.equal(site.data().metadata.customField, 'Keep');
  assert.equal(site.alerts.length, 1);
  assert(site.alerts[0].includes('Импортировано'));
});

test('translation import uses current data and preserves the previous confirmed version', async () => {
  const site = createSite({ strings: { 1: entry('Оригинал', 'Old', { confirmedBy: 'u' }) }, metadata: {} });
  editor(site);
  site.run(`importTranslationsFromWTS({text: ${JSON.stringify(wts(1, 'New'))}})`);
  await flush();
  assert.equal(site.data().strings[1].translation, 'New');
  assert.equal(site.data().strings[1].lastConfirmedTranslation, 'Old');
  assert.equal(site.data().strings[1].confirmed, false);
  assert.equal(site.alerts.length, 1);
  assert(site.alerts[0].includes('Обновлено'));
});

test('import aborts on a concurrent edit before the atomic update', async () => {
  const site = createSite({ strings: { 1: entry('Оригинал', 'Old') }, metadata: {} });
  editor(site);
  site.beforeWrite(data => { data.strings[1].translation = 'Concurrent'; });
  site.run(`importTranslationsFromWTS({text: ${JSON.stringify(wts(1, 'New'))}})`);
  await flush();
  assert.equal(site.data().strings[1].translation, 'Concurrent');
  assert.equal(site.writes.length, 0);
  assert(site.alerts[0].includes('Запись отклонена'));
});

test('original editing aborts when a comment is added concurrently', async () => {
  const site = createSite({ strings: { 1: entry('Оригинал') }, metadata: {} });
  editor(site);
  site.beforeWrite(data => { data.strings[1].userComments = [{ text: 'Concurrent' }]; });
  site.run("saveOriginalEdit('1', 'Новый оригинал')");
  await flush();
  assert.equal(site.data().strings[1].original, 'Оригинал');
  assert.equal(site.data().strings[1].userComments.length, 1);
  assert.equal(site.writes.length, 0);
});

test('activity changes require an editor and leave local state consistent on failure', async () => {
  const site = createSite({ strings: { 1: entry('Оригинал') }, metadata: {} });
  site.run("toggleInactive('1')");
  await flush();
  assert.equal(site.writes.length, 0);
  editor(site);
  site.beforeWrite(data => { data.strings[1].translation = 'Concurrent'; });
  site.run("toggleInactive('1')");
  await flush();
  assert.equal(site.run('allData[0].inactive'), false);
  assert.equal(site.writes.length, 0);
});
