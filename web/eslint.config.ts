import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  react: true,
  typescript: {
    tsconfigPath: 'tsconfig.json',
  },
  rules: {
    'node/prefer-global/process': 'off',
    'ts/no-unsafe-argument': 'off',
    'ts/no-unsafe-assignment': 'off',
    'ts/no-unsafe-call': 'off',
    'ts/no-unsafe-member-access': 'off',
    'ts/no-unsafe-return': 'off',
    'ts/strict-boolean-expressions': 'off',
  },
  ignores: [
    'dist/**',
    'src/app/routeTree.gen.ts',
  ],
})
