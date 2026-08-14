#!/usr/bin/env bash

# Runtime bundle installs should not inherit workstation proxy settings. Those
# proxies are useful for some development traffic but make domestic npm
# registry requests take an unnecessary and less reliable extra hop.

DEFAULT_YEP_DEPLOY_NPM_REGISTRY="https://registry.npmmirror.com/"

deploy_npm_registry() {
  printf '%s' "${YEP_DEPLOY_NPM_REGISTRY:-$DEFAULT_YEP_DEPLOY_NPM_REGISTRY}"
}

run_deploy_npm_direct() {
  local registry
  registry="$(deploy_npm_registry)"

  env \
    -u HTTP_PROXY \
    -u HTTPS_PROXY \
    -u ALL_PROXY \
    -u http_proxy \
    -u https_proxy \
    -u all_proxy \
    -u NPM_CONFIG_PROXY \
    -u NPM_CONFIG_HTTPS_PROXY \
    -u NPM_CONFIG_REGISTRY \
    -u npm_config_proxy \
    -u npm_config_https_proxy \
    -u npm_config_registry \
    npm_config_proxy= \
    npm_config_https_proxy= \
    npm_config_registry="$registry" \
    npm "$@"
}
