export type Pagination = {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export function calculatePagination(
  totalItems: number,
  pageSize: number,
  currentPage: number,
): Pagination {
  const totalPages = Math.max(1, Math.floor(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  return {
    currentPage: safePage,
    totalPages,
    pageSize,
    totalItems,
    hasNextPage: safePage < totalPages,
    hasPreviousPage: safePage > 1,
  };
}
