import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  react: true,
  typescript: {
    tsconfigPath: 'tsconfig.json',
  },
  ignores: [
    'src/features/*/lib/api-client/**',
    'src/features/*/lib/api.ts',
    'src/shared/components/ui/**',
    'dist/**',
  ],
})
