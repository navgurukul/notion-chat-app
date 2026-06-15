# TODO - Cost Report Enhancements

- [x] Update `src/app/cosr-report/AwsComputeCost.ts` to add RDS monthly estimation (placeholder) and cleaner exports.

- [x] Refactor `src/app/cosr-report/CostReportPage.tsx`:
  - [ ] Add interactive inputs: number of users, questions/day/user, model multi-select.
  - [ ] Add scrollable model breakdown UI.
  - [ ] Compute and display overall monthly cost (sum of selected models + EC2 + RDS).
  - [ ] Expand `MODELS` list to include GPT-4 variants + more DeepSeek variants (with placeholder pricing).
  - [ ] Keep current token estimation approach and show assumptions.
- [ ] Run `npm run lint` and `npm run build` to verify.

