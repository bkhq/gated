image-ssh-server:
	cd images/ssh-server && docker build -t gated-e2e-ssh-server .

image-mysql-server:
	cd images/mysql-server && docker build -t gated-e2e-mysql-server .

image-postgres-server:
	cd images/postgres-server && docker build -t gated-e2e-postgres-server .

all: image-ssh-server image-mysql-server image-postgres-server
