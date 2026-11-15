import { mount } from 'svelte'
import './app.css'
import Bootstrap from './Bootstrap.svelte'
import { customCss } from './lib/custom-css.svelte'
import { themeSource } from './lib/theme-source.svelte'

// Link theme first, custom CSS after it: the user's CSS wins.
themeSource.start()
customCss.apply()

export default mount(Bootstrap, { target: document.getElementById('app')! })
