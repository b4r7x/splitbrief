export type CreateUserInput = {
  email: string;
  name: string;
  phone?: string;
};

export type CreatedUser = {
  id: string;
  email: string;
  name: string;
  phone?: string;
};

export type CreateUserResponse = {
  status: number;
  body: CreatedUser | { error: string };
};

let nextUserId = 1;

export function resetUsersForTest(): void {
  nextUserId = 1;
}

export function createUser(input: CreateUserInput): CreateUserResponse {
  const user: CreatedUser = {
    id: `user_${nextUserId}`,
    email: input.email,
    name: input.name,
    ...(input.phone === undefined ? {} : { phone: input.phone }),
  };

  nextUserId += 1;

  return {
    status: 201,
    body: user,
  };
}
