import { mount } from 'svelte'
import './app.css'
import Bootstrap from './Bootstrap.svelte'
import { customCss } from './lib/custom-css.svelte'

customCss.apply()

export default mount(Bootstrap, { target: document.getElementById('app')! })
