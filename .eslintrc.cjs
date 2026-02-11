module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  ignorePatterns: ['dist/', 'coverage/', 'vendor/', 'node_modules/'],
  rules: {
    'no-undef': 'off',
    'no-unused-vars': 'off',
  },
};
