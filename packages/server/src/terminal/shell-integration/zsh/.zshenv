typeset -g PIMI_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${PIMI_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${PIMI_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${PIMI_SHELL_INTEGRATION_DIR}/paseo-integration.zsh"
