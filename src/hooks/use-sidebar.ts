import { useState } from 'react';

export function useSidebar(isSmall: boolean) {
  const [userWants, setUserWants] = useState(false);

  const toggle = () => {
    if (isSmall) return;
    setUserWants((prev) => !prev);
  };

  return { visible: userWants && !isSmall, toggle };
}
