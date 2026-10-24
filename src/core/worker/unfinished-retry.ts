export async function retryUnfinishedResultsInOrder<T>(
  results: T[],
  retry: (index: number, result: T) => Promise<T>,
  advance?: (index: number) => Promise<void>,
  isFinished: (result: T) => boolean = (result) => Boolean((result as { finish?: boolean })?.finish),
  shouldContinue: () => boolean = () => true,
  waitForContinue?: () => Promise<void>
): Promise<T[]> {
  const updated = results.slice();
  for (let index = 0; index < results.length; index++) {
    await waitForContinue?.();
    if (!shouldContinue()) {
      break;
    }
    if (!isFinished(results[index])) {
      updated[index] = await retry(index, results[index]);
    }
    if (index < results.length - 1) {
      await waitForContinue?.();
      if (shouldContinue()) {
        await advance?.(index);
      }
    }
  }
  return updated;
}
