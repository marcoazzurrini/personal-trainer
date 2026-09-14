update fixture_records set value = 'upgraded' where id = 1;
create table fixture_upgrade_artifact (id integer primary key);
insert into fixture_upgrade_artifact values (1);
do $$
begin
  if not (select allow_upgrade from fixture_control) then
    raise exception 'injected failure after migration writes';
  end if;
end $$;
