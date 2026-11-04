'use strict';

const messages = { en: require('./translations/en.json'), ru: require('./translations/ru.json') };
let current = 'en';

function resolveLanguage(preference = 'auto', editorLanguage = 'en') {
  if (preference === 'en' || preference === 'ru') return preference;
  return /^ru(?:-|$)/i.test(editorLanguage) ? 'ru' : 'en';
}

function setLanguage(preference, editorLanguage) {
  current = resolveLanguage(preference, editorLanguage);
  return current;
}

function t(key, args = {}) {
  const template = messages[current][key] ?? messages.en[key];
  if (template === undefined) throw new Error(`Unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(args[name] ?? `{${name}}`));
}

function errorText(error) {
  return error?.sessionTabsKey && Object.hasOwn(messages.en, error.sessionTabsKey)
    ? t(error.sessionTabsKey) : String(error?.message || error);
}

function draftNumber(title) {
  const match = /^(?:New chat|Новый диалог) ([1-9]\d*)$/.exec(title || '');
  const number = match && Number(match[1]);
  return Number.isSafeInteger(number) ? number : undefined;
}

function formatDate(value) {
  return new Date(value).toLocaleString(current === 'ru' ? 'ru-RU' : 'en-US');
}

module.exports = { t, errorText, draftNumber, formatDate, resolveLanguage, setLanguage, language: () => current };
