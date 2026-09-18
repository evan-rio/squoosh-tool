import { h, Component } from 'preact';

import {
  getLocale,
  setLocale,
  localeNames,
  locales,
  t,
  Locale,
} from 'shared/i18n';

const wrapperStyle = {
  display: 'inline-flex',
  alignItems: 'center',
};

const selectStyle = {
  font: 'inherit',
  fontSize: '14px',
  padding: '4px 8px',
  borderRadius: '4px',
  border: '1px solid rgba(0, 0, 0, 0.2)',
  background: '#fff',
  color: 'inherit',
  cursor: 'pointer',
};

interface Props {
  /** Extra inline styles, so callers can position the control in their layout. */
  style?: Record<string, string>;
}

/**
 * Display-language switcher. Changing the locale persists the choice and
 * reloads, which re-renders every component in the new language.
 */
export default class LocaleSelect extends Component<Props> {
  private onChange = (event: Event) => {
    const locale = (event.currentTarget as HTMLSelectElement).value as Locale;
    if (locale === getLocale()) return;
    setLocale(locale);
    document.documentElement.lang = locale;
    location.reload();
  };

  render() {
    return (
      <label
        class="locale-select"
        style={{ ...wrapperStyle, ...this.props.style }}
      >
        <select
          style={selectStyle}
          value={getLocale()}
          onChange={this.onChange}
          title={t('common.language')}
        >
          {locales.map((locale) => (
            <option value={locale}>{localeNames[locale]}</option>
          ))}
        </select>
      </label>
    );
  }
}
