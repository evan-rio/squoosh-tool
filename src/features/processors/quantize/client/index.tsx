import { h, Component } from 'preact';
import { Options as QuantizeOptions } from '../shared/meta';
import * as style from 'client/lazy-app/Compress/Options/style.css';
import {
  inputFieldValueAsNumber,
  konami,
  preventDefault,
} from 'client/lazy-app/util';
import Expander from 'client/lazy-app/Compress/Options/Expander';
import Select from 'client/lazy-app/Compress/Options/Select';
import Range from 'client/lazy-app/Compress/Options/Range';
import { t } from 'shared/i18n';

const konamiPromise = konami();

interface Props {
  options: QuantizeOptions;
  onChange(newOptions: QuantizeOptions): void;
}

interface State {
  extendedSettings: boolean;
}

export class Options extends Component<Props, State> {
  state: State = { extendedSettings: false };

  componentDidMount() {
    konamiPromise.then(() => {
      this.setState({ extendedSettings: true });
    });
  }

  onChange = (event: Event) => {
    const form = (event.currentTarget as HTMLInputElement).closest(
      'form',
    ) as HTMLFormElement;
    const { options } = this.props;

    const newOptions: QuantizeOptions = {
      zx: inputFieldValueAsNumber(form.zx, options.zx),
      maxNumColors: inputFieldValueAsNumber(
        form.maxNumColors,
        options.maxNumColors,
      ),
      dither: inputFieldValueAsNumber(form.dither),
    };
    this.props.onChange(newOptions);
  };

  render({ options }: Props, { extendedSettings }: State) {
    return (
      <form class={style.optionsSection} onSubmit={preventDefault}>
        <Expander>
          {extendedSettings ? (
            <label class={style.optionTextFirst}>
              {t('quantize.type')}
              <Select
                name="zx"
                value={'' + options.zx}
                onChange={this.onChange}
              >
                <option value="0">{t('quantize.type.standard')}</option>
                <option value="1">{t('quantize.type.zx')}</option>
              </Select>
            </label>
          ) : null}
        </Expander>
        <Expander>
          {options.zx ? null : (
            <div class={style.optionOneCell}>
              <Range
                name="maxNumColors"
                min="2"
                max="256"
                value={options.maxNumColors}
                onInput={this.onChange}
              >
                {t('quantize.colors')}
              </Range>
            </div>
          )}
        </Expander>
        <div class={style.optionOneCell}>
          <Range
            name="dither"
            min="0"
            max="1"
            step="0.01"
            value={options.dither}
            onInput={this.onChange}
          >
            {t('quantize.dithering')}
          </Range>
        </div>
      </form>
    );
  }
}
