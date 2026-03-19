const ADMIN_TOKEN = "token-value";

export interface Role {
  id: string;
  name: string;
}

export interface User {
  id: string;
  username: string;
}

export interface Target {
  id: string;
  name: string;
  options: any;
}

export interface Ticket {
  secret: string;
}

export interface Parameters {
  allow_own_credential_management: boolean;
  rate_limit_bytes_per_second: number | null;
  ssh_client_auth_publickey: boolean;
  ssh_client_auth_password: boolean;
  ssh_client_auth_keyboard_interactive: boolean;
}

export interface IssuedCertificate {
  certificate_pem: string;
}

export class AdminClient {
  private baseUrl: string;

  constructor(host: string) {
    this.baseUrl = `${host}/@gated/admin/api`;
  }

  private async request(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-Gated-Token": ADMIN_TOKEN,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      tls: { rejectUnauthorized: false },
    } as any);
    if (resp.status === 401) {
      throw new ApiError(401, await resp.text());
    }
    if (resp.status >= 400) {
      throw new ApiError(resp.status, await resp.text());
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  async createRole(data: { name: string }): Promise<Role> {
    return this.request("POST", "/roles", data);
  }

  async getRoles(search?: string): Promise<Role[]> {
    const q = search ? `?search=${encodeURIComponent(search)}` : "";
    return this.request("GET", `/roles${q}`);
  }

  async createUser(data: { username: string }): Promise<User> {
    return this.request("POST", "/users", data);
  }

  async getUsers(): Promise<User[]> {
    return this.request("GET", "/users");
  }

  async updateUser(
    userId: string,
    data: {
      username: string;
      credential_policy?: {
        http?: string[];
        ssh?: string[];
        postgres?: string[];
      };
    }
  ): Promise<User> {
    return this.request("PUT", `/users/${userId}`, data);
  }

  async getUserRoles(userId: string): Promise<Role[]> {
    return this.request("GET", `/users/${userId}/roles`);
  }

  async createPasswordCredential(
    userId: string,
    data: { password: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/users/${userId}/credentials/passwords`,
      data
    );
  }

  async createPublicKeyCredential(
    userId: string,
    data: { label: string; openssh_public_key: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/users/${userId}/credentials/public-keys`,
      data
    );
  }

  async createOtpCredential(
    userId: string,
    data: { secret_key: number[] }
  ): Promise<void> {
    await this.request(
      "POST",
      `/users/${userId}/credentials/otp`,
      data
    );
  }

  async createSsoCredential(
    userId: string,
    data: { email: string; provider: string }
  ): Promise<void> {
    await this.request(
      "POST",
      `/users/${userId}/credentials/sso`,
      data
    );
  }

  async issueCertificateCredential(
    userId: string,
    data: { label: string; public_key_pem: string }
  ): Promise<IssuedCertificate> {
    return this.request(
      "POST",
      `/users/${userId}/credentials/certificates`,
      data
    );
  }

  async addUserRole(userId: string, roleId: string): Promise<void> {
    await this.request("POST", `/users/${userId}/roles/${roleId}`);
  }

  async createTarget(data: {
    name: string;
    options: any;
  }): Promise<Target> {
    return this.request("POST", "/targets", data);
  }

  async updateTarget(
    targetId: string,
    data: { name: string; options: any }
  ): Promise<Target> {
    return this.request("PUT", `/targets/${targetId}`, data);
  }

  async addTargetRole(targetId: string, roleId: string): Promise<void> {
    await this.request("POST", `/targets/${targetId}/roles/${roleId}`);
  }

  async createTicket(data: {
    target_name: string;
    username: string;
  }): Promise<Ticket> {
    return this.request("POST", "/tickets", data);
  }

  async getParameters(): Promise<Parameters> {
    return this.request("GET", "/parameters");
  }

  async updateParameters(data: Parameters): Promise<void> {
    await this.request("PUT", "/parameters", data);
  }

  async getSessions(): Promise<any[]> {
    const resp = await this.request("GET", "/sessions");
    return resp.items || [];
  }

  async getSession(id: string): Promise<any> {
    return this.request("GET", `/sessions/${id}`);
  }

  async getRole(id: string): Promise<Role> {
    return this.request("GET", `/role/${id}`);
  }

  async getUser(id: string): Promise<User> {
    return this.request("GET", `/users/${id}`);
  }

  async getTarget(id: string): Promise<Target> {
    return this.request("GET", `/targets/${id}`);
  }

  async getTargets(): Promise<Target[]> {
    return this.request("GET", "/targets");
  }

  async deleteTarget(id: string): Promise<void> {
    await this.request("DELETE", `/targets/${id}`);
  }

  async getTargetRoles(targetId: string): Promise<Role[]> {
    return this.request("GET", `/targets/${targetId}/roles`);
  }

  async removeTargetRole(targetId: string, roleId: string): Promise<void> {
    await this.request("DELETE", `/targets/${targetId}/roles/${roleId}`);
  }

  async updateRole(id: string, data: { name: string }): Promise<Role> {
    return this.request("PUT", `/role/${id}`, data);
  }

  async deleteRole(id: string): Promise<void> {
    await this.request("DELETE", `/role/${id}`);
  }

  async getRoleTargets(id: string): Promise<Target[]> {
    return this.request("GET", `/role/${id}/targets`);
  }

  async deleteUser(id: string): Promise<void> {
    await this.request("DELETE", `/users/${id}`);
  }

  async removeUserRole(userId: string, roleId: string): Promise<void> {
    await this.request("DELETE", `/users/${userId}/roles/${roleId}`);
  }

  async getPasswordCredentials(userId: string): Promise<any[]> {
    return this.request("GET", `/users/${userId}/credentials/passwords`);
  }

  async deletePasswordCredential(userId: string, id: string): Promise<void> {
    await this.request("DELETE", `/users/${userId}/credentials/passwords/${id}`);
  }

  async getPublicKeyCredentials(userId: string): Promise<any[]> {
    return this.request("GET", `/users/${userId}/credentials/public-keys`);
  }

  async deletePublicKeyCredential(userId: string, id: string): Promise<void> {
    await this.request("DELETE", `/users/${userId}/credentials/public-keys/${id}`);
  }

  async getOtpCredentials(userId: string): Promise<any[]> {
    return this.request("GET", `/users/${userId}/credentials/otp`);
  }

  async deleteOtpCredential(userId: string, id: string): Promise<void> {
    await this.request("DELETE", `/users/${userId}/credentials/otp/${id}`);
  }

  async getSsoCredentials(userId: string): Promise<any[]> {
    return this.request("GET", `/users/${userId}/credentials/sso`);
  }

  async deleteSsoCredential(userId: string, id: string): Promise<void> {
    await this.request("DELETE", `/users/${userId}/credentials/sso/${id}`);
  }

  async getCertificateCredentials(userId: string): Promise<any[]> {
    return this.request("GET", `/users/${userId}/credentials/certificates`);
  }

  async deleteCertificateCredential(userId: string, id: string): Promise<void> {
    await this.request("DELETE", `/users/${userId}/credentials/certificates/${id}`);
  }

  async getTickets(): Promise<any[]> {
    return this.request("GET", "/tickets");
  }

  async deleteTicket(id: string): Promise<void> {
    await this.request("DELETE", `/tickets/${id}`);
  }

  async deleteSessions(): Promise<void> {
    await this.request("DELETE", "/sessions");
  }

  async closeSession(id: string): Promise<void> {
    await this.request("POST", `/sessions/${id}/close`);
  }

  async getSshOwnKeys(): Promise<any[]> {
    return this.request("GET", "/ssh/own-keys");
  }

  async getSshKnownHosts(): Promise<any[]> {
    return this.request("GET", "/ssh/known-hosts");
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(`API error ${status}: ${message}`);
  }
}

export function adminClient(host: string): AdminClient {
  return new AdminClient(host);
}
