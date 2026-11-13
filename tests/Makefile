image-ssh-server:
	cd images/ssh-server && docker build -t gated-e2e-ssh-server .

image-mysql-server:
	cd images/mysql-server && docker build -t gated-e2e-mysql-server .

image-postgres-server:
	cd images/postgres-server && docker build -t gated-e2e-postgres-server .

image-vnc-server:
	cd images/vnc-server && docker build -t gated-e2e-vnc-server .

image-rdp-server:
	cd images/rdp-server && docker build -t gated-e2e-rdp-server .

all: image-ssh-server image-mysql-server image-postgres-server image-vnc-server image-rdp-server
