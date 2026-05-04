export interface StoredUser {
  id: string;
  username: string;
  /** format: "hexSalt:hexHash" */
  passwordHash: string;
  createdAt: string;
}

export interface UserRepository {
  findAll(): Promise<StoredUser[]>;
  findByUsername(username: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
  create(user: StoredUser): Promise<void>;
}
