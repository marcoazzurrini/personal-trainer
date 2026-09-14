-- A deliberately small older record, populated before the upgrade.
create table fixture_control (allow_upgrade boolean not null);
insert into fixture_control values (false);
create table fixture_records (id integer primary key, value text not null);
insert into fixture_records values (1, 'original');
