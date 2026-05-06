export const cors = {
  defineTopFunction<TArgs extends unknown[]>(fn: (...args: TArgs) => void) {
    return (...args: TArgs) => {
      fn(...args);
    };
  }
};
